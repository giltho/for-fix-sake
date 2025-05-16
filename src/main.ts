import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Octokit } from 'octokit';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import AdmZip from 'adm-zip';

// Define types for GitHub API responses
interface GitHubContent {
  type: "dir" | "file" | "submodule" | "symlink";
  size: number;
  name: string;
  path: string;
  content?: string;
  sha: string;
  url: string;
  git_url: string | null;
  html_url: string | null;
  download_url: string | null;
  _links: any;
}

// Define the setting interface
interface ForFixSakeSettings {
  githubToken: string;
  defaultKeywords: string[];
  cacheEnabled: boolean;
  cacheExpiry: number; // In minutes
  tempDir: string; // Directory for storing downloaded repositories
}

// Cache structure
interface CacheEntry {
  timestamp: number;
  data: any;
  etag?: string;
}

interface RepoCache {
  latestCommit: string;
  downloadPath: string;
  extractPath: string;
  timestamp: number;
}

interface PluginCache {
  [key: string]: CacheEntry;
}

interface RepoMap {
  [key: string]: RepoCache;
}

// Define default settings
const DEFAULT_SETTINGS: ForFixSakeSettings = {
  githubToken: '',
  defaultKeywords: ['TODO', 'FIXME'],
  cacheEnabled: true,
  cacheExpiry: 60, // 60 minutes
  tempDir: os.tmpdir() // Directory for storing downloaded repositories
}

export default class ForFixSakePlugin extends Plugin {
  settings: ForFixSakeSettings;
  cache: PluginCache = {};
  repoCache: RepoMap = {};

  async onload() {
    await this.loadSettings();

    // Create temp directory if it doesn't exist
    this.ensureTempDirExists();

    // Register for-fix-sake code block processor
    this.registerMarkdownCodeBlockProcessor('for-fix-sake', async (source, el, ctx) => {
      // Parse the code block content
      const lines = source.split('\n');
      let repo = '';
      let keywords = this.settings.defaultKeywords;
      let forceApi = false;

      for (const line of lines) {
        if (line.startsWith('repo:')) {
          repo = line.substring('repo:'.length).trim();
        } else if (line.startsWith('keywords:')) {
          const keywordString = line.substring('keywords:'.length).trim();
          keywords = keywordString.split(/\s+/);
        } else if (line.startsWith('force-api:')) {
          const forceApiString = line.substring('force-api:'.length).trim().toLowerCase();
          forceApi = forceApiString === 'true';
        }
      }

      if (!repo) {
        el.createEl('div', { text: 'Error: No repository specified' });
        return;
      }

      try {
        // Show loading message
        const loadingEl = el.createEl('div', { text: 'Loading...' });

        let issues;

        // Use local search by default unless force-api is specified
        if (!forceApi) {
          try {
            loadingEl.textContent = 'Downloading repository and searching locally...';
            issues = await this.fetchIssuesLocally(repo, keywords);
          } catch (localError) {
            console.error('Local search failed, falling back to API:', localError);
            loadingEl.textContent = 'Local search failed, using GitHub API...';
            issues = await this.fetchIssues(repo, keywords);
          }
        } else {
          loadingEl.textContent = 'Using GitHub API...';
          issues = await this.fetchIssues(repo, keywords);
        }

        // Remove loading element
        loadingEl.remove();

        this.renderIssues(issues, el);
      } catch (error) {
        // Error container with better styling
        const errorEl = el.createEl('div', { cls: 'for-fix-sake-error' });
        errorEl.style.backgroundColor = 'var(--background-modifier-error)';
        errorEl.style.color = 'var(--text-on-accent)';
        errorEl.style.padding = '10px';
        errorEl.style.borderRadius = '4px';
        errorEl.style.marginTop = '10px';

        // Check specific error types
        if (error.status === 404 && !this.settings.githubToken) {
          errorEl.createEl('h3', { text: 'Repository Not Found' });
          errorEl.createEl('p', { text: 'This may be a private repository. Please configure a GitHub token in the plugin settings.' });
        } else if (error.status === 403 && error.message.includes('rate limit') || error.message.includes('quota exhausted')) {
          errorEl.createEl('h3', { text: 'GitHub API Rate Limit Reached' });
          errorEl.createEl('p', { text: 'You have reached GitHub\'s API rate limit for unauthenticated requests.' });
          errorEl.createEl('p', { text: 'To increase your rate limit, please add a GitHub token in the plugin settings.' });

          // Add link to settings
          const settingsLink = errorEl.createEl('a', {
            text: 'Open Plugin Settings',
            href: '#'
          });
          settingsLink.style.color = 'var(--text-on-accent)';
          settingsLink.style.textDecoration = 'underline';
          settingsLink.addEventListener('click', () => {
            // Just show a notice with instructions
            new Notice('Please go to Settings → Plugin Options → For Fix Sake');

            // Try to open settings if we can
            try {
              // @ts-ignore - App structure might vary across Obsidian versions
              if (this.app.setting) {
                // @ts-ignore
                this.app.setting.open();
              }
            } catch (e) {
              console.log('Could not automatically open settings');
            }
          });
        } else {
          errorEl.createEl('h3', { text: 'Error' });
          errorEl.createEl('p', { text: `Failed to fetch issues: ${error.message}` });
        }
      }
    });

    // Add settings tab
    this.addSettingTab(new ForFixSakeSettingTab(this.app, this));
  }

  async fetchIssues(repo: string, keywords: string[]) {
    // First, check if this repo is already known to be rate limited
    const rateLimitKey = `ratelimit-${repo}`;
    if (this.settings.cacheEnabled && this.cache[rateLimitKey] && this.cache[rateLimitKey].data === true) {
      const now = Date.now();
      const expiryTime = this.settings.cacheExpiry * 60 * 1000; // Convert minutes to milliseconds

      // If cache entry is still valid, immediately throw a rate limit error
      if (now - this.cache[rateLimitKey].timestamp < expiryTime) {
        console.log('Repository is rate limited:', repo);

        // Try the local approach instead when rate limited
        try {
          console.log('Trying local file search instead...');
          return await this.fetchIssuesLocally(repo, keywords);
        } catch (localError) {
          console.error('Local search failed:', localError);
          const error: any = new Error('GitHub API rate limit exceeded');
          error.status = 403;
          error.isRateLimit = true;
          throw error;
        }
      }
    }

    // Check cache first if enabled
    const cacheKey = `${repo}-${keywords.join(',')}`;
    if (this.settings.cacheEnabled && this.cache[cacheKey]) {
      const cacheEntry = this.cache[cacheKey];
      const now = Date.now();
      const expiryTime = this.settings.cacheExpiry * 60 * 1000; // Convert minutes to milliseconds

      // Use cache if not expired
      if (now - cacheEntry.timestamp < expiryTime) {
        console.log('Using cached data for', repo);
        return cacheEntry.data;
      }
    }

    // Create Octokit instance with or without authentication
    const octokit = this.settings.githubToken
      ? new Octokit({ auth: this.settings.githubToken })
      : new Octokit();

    const [owner, repoName] = repo.split('/');

    if (!owner || !repoName) {
      throw new Error('Invalid repository format. Use "owner/repo"');
    }

    // Fetch the repository contents
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo: repoName,
    });

    // Get default branch
    const defaultBranch = repoData.default_branch;

    // Search for files in the repository
    const results = [];

    // Recursively get all files in the repository
    async function getFilesRecursively(path = ''): Promise<any[]> {
      const { data: contents } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path,
        ref: defaultBranch,
      });

      const files: GitHubContent[] = [];

      // Handle both array and single object responses
      const contentArray = Array.isArray(contents) ? contents : [contents];

      for (const item of contentArray) {
        if (item.type === 'dir') {
          const subFiles = await getFilesRecursively(item.path);
          files.push(...subFiles);
        } else if (item.type === 'file') {
          files.push(item);
        }
      }

      return files;
    }

    const files = await getFilesRecursively();

    // Process each file
    for (const file of files) {
      // Skip binary files and large files
      if (file.size > 500000 || !file.name.match(/\.(js|jsx|ts|tsx|py|java|rb|php|c|cpp|h|hpp|cs|go|rs|swift|kt|sh|md|txt|ml|mli)$/i)) {
        continue;
      }

      const { data: contentData } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: file.path,
        ref: defaultBranch,
      });

      // Ensure we have a single file object
      const fileData = Array.isArray(contentData) ? null : contentData as GitHubContent;

      // Skip if not a file with content
      if (!fileData || !fileData.content) continue;

      // Decode base64 content
      const content = Buffer.from(fileData.content, 'base64').toString();

      // Check for keywords
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const keyword of keywords) {
          if (line.includes(`${keyword}:`)) {
            // Include the next line if available
            const nextLine = i + 1 < lines.length ? '\n' + lines[i + 1].trim() : '';
            results.push({
              file: file.path,
              line: i + 1,
              content: line.trim() + nextLine,
              url: `https://github.com/${owner}/${repoName}/blob/${defaultBranch}/${file.path}#L${i + 1}`
            });
          }
        }
      }
    }

    // Cache the results if caching is enabled
    if (this.settings.cacheEnabled) {
      this.cache[cacheKey] = {
        timestamp: Date.now(),
        data: results
      };
    }

    return results;
  }

  renderIssues(issues: any[], el: HTMLElement) {
    if (issues.length === 0) {
      el.createEl('div', { text: 'No issues found' });
      return;
    }

    const container = el.createEl('div', { cls: 'for-fix-sake-container' });

    // Style the container
    container.style.border = '1px solid var(--background-modifier-border)';
    container.style.borderRadius = '4px';
    container.style.padding = '10px';
    container.style.backgroundColor = 'var(--background-secondary)';

    // Create header with counter
    container.createEl('h3', { text: `Found ${issues.length} issues` });

    // Add filter inputs
    const filterContainer = container.createEl('div', { cls: 'for-fix-sake-filter' });
    filterContainer.style.marginBottom = '10px';

    const filterInput = filterContainer.createEl('input', {
      attr: {
        type: 'text',
        placeholder: 'Filter issues...'
      }
    });
    filterInput.style.width = '100%';
    filterInput.style.padding = '4px 8px';
    filterInput.style.borderRadius = '4px';
    filterInput.style.border = '1px solid var(--background-modifier-border)';
    filterInput.style.marginBottom = '8px';

    // Create a map of file extensions to their language names
    const fileExtToLanguage: { [key: string]: string } = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'swift': 'swift',
      'kt': 'kotlin',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'md': 'markdown',
      'json': 'json',
      'yml': 'yaml',
      'yaml': 'yaml',
      'xml': 'xml',
      'sh': 'bash',
      'bash': 'bash',
      'ml': 'ocaml',
      'mli': 'ocaml'
    };

    // Create issues list
    const list = container.createEl('ul');
    list.style.listStyleType = 'none';
    list.style.padding = '0';
    list.style.margin = '0';

    const listItems: HTMLLIElement[] = [];

    issues.forEach(issue => {
      const item = list.createEl('li');
      listItems.push(item);

      item.style.margin = '8px 0';
      item.style.padding = '12px';
      item.style.backgroundColor = 'var(--background-primary)';
      item.style.borderRadius = '4px';
      item.style.borderLeft = '4px solid';

      // Determine the color based on the keyword
      const content = issue.content.toLowerCase();
      if (content.includes('fixme')) {
        item.style.borderLeftColor = '#e74c3c'; // Red for FIXME
      } else if (content.includes('todo')) {
        item.style.borderLeftColor = '#2ecc71'; // Green for TODO
      } else {
        item.style.borderLeftColor = '#3498db'; // Blue for other keywords
      }

      // File header section
      const fileHeader = item.createEl('div', { cls: 'for-fix-sake-file-header' });
      fileHeader.style.display = 'flex';
      fileHeader.style.alignItems = 'center';
      fileHeader.style.marginBottom = '8px';

      // File name with link
      const fileLink = fileHeader.createEl('a', {
        text: issue.file,
        href: issue.url
      });
      fileLink.style.fontWeight = 'bold';
      fileLink.style.color = 'var(--interactive-accent)';
      fileLink.style.marginRight = '8px';
      fileLink.style.textDecoration = 'none';
      fileLink.addEventListener('mouseenter', () => {
        fileLink.style.textDecoration = 'underline';
      });
      fileLink.addEventListener('mouseleave', () => {
        fileLink.style.textDecoration = 'none';
      });

      // Line number badge
      const lineNumber = fileHeader.createEl('span', {
        text: `Line ${issue.line}`,
        cls: 'for-fix-sake-line-number'
      });
      lineNumber.style.backgroundColor = 'var(--interactive-accent)';
      lineNumber.style.color = 'white';
      lineNumber.style.padding = '2px 6px';
      lineNumber.style.borderRadius = '4px';
      lineNumber.style.fontSize = '12px';
      lineNumber.style.fontWeight = 'bold';

      // Add file extension badge if we can determine it
      const fileExt = issue.file.split('.').pop()?.toLowerCase();
      if (fileExt && fileExtToLanguage[fileExt]) {
        const langBadge = fileHeader.createEl('span', {
          text: fileExtToLanguage[fileExt],
          cls: 'for-fix-sake-lang-badge'
        });
        langBadge.style.backgroundColor = 'var(--background-modifier-border)';
        langBadge.style.color = 'var(--text-normal)';
        langBadge.style.padding = '2px 6px';
        langBadge.style.borderRadius = '4px';
        langBadge.style.fontSize = '12px';
        langBadge.style.marginLeft = '8px';
      }

      // Issue content with syntax highlighting
      const codeBlock = item.createEl('div', { cls: 'for-fix-sake-code-block' });
      codeBlock.style.marginTop = '8px';
      codeBlock.style.background = 'var(--background-secondary)';
      codeBlock.style.borderRadius = '4px';
      codeBlock.style.overflow = 'hidden';

      // Create a pre element for the code
      const pre = codeBlock.createEl('pre', { cls: 'for-fix-sake-pre' });
      pre.style.margin = '0';
      pre.style.padding = '8px 12px';
      pre.style.overflowX = 'auto';

      // Create a code element with language class if available
      const language = fileExt && fileExtToLanguage[fileExt] ? fileExtToLanguage[fileExt] : '';
      const code = pre.createEl('code', {
        cls: language ? `language-${language}` : '',
        text: issue.content
      });

      // Try to highlight specific keywords within the code
      const highlightKeyword = (keyword: string, color: string) => {
        if (issue.content.toLowerCase().includes(keyword.toLowerCase())) {
          try {
            // This is a simple approach that might not be perfect for all cases
            // A more robust solution would use a proper code parsing library
            const regex = new RegExp(`(${keyword})`, 'i');
            code.innerHTML = code.innerHTML.replace(regex, `<span style="color: ${color}; font-weight: bold;">$1</span>`);
          } catch (e) {
            // Ignore regex errors
          }
        }
      };

      // Highlight common keywords
      highlightKeyword('TODO', '#2ecc71');  // Green
      highlightKeyword('FIXME', '#e74c3c'); // Red
      highlightKeyword('BUG', '#e67e22');   // Orange
      highlightKeyword('HACK', '#9b59b6');  // Purple
      highlightKeyword('NOTE', '#3498db');  // Blue
    });

    // Add filter functionality
    filterInput.addEventListener('input', () => {
      const filterText = filterInput.value.toLowerCase();
      listItems.forEach(item => {
        const text = item.textContent?.toLowerCase() || '';
        if (filterText === '' || text.includes(filterText)) {
          item.style.display = '';
        } else {
          item.style.display = 'none';
        }
      });
    });
  }

  onunload() {
    // Nothing to clean up
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  ensureTempDirExists() {
    try {
      if (!fs.existsSync(this.settings.tempDir)) {
        fs.mkdirSync(this.settings.tempDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create temp directory:', error);
    }
  }

  async downloadFile(url: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Add auth header if we have a GitHub token
      const options: https.RequestOptions = {};
      if (this.settings.githubToken) {
        options.headers = {
          'Authorization': `token ${this.settings.githubToken}`,
          // Add a user agent to avoid GitHub API issues
          'User-Agent': 'For-Fix-Sake-Obsidian-Plugin'
        };
      } else {
        options.headers = {
          'User-Agent': 'For-Fix-Sake-Obsidian-Plugin'
        };
      }

      const file = fs.createWriteStream(destination);

      https.get(url, options, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            // Close the current file stream
            file.close();
            this.downloadFile(redirectUrl, destination)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        // Check for error status codes
        if (response.statusCode !== 200) {
          // Close the file
          file.close();
          // Delete the file to avoid corrupted downloads
          fs.unlinkSync(destination);
          reject(new Error(`Failed to download file: ${response.statusCode} ${response.statusMessage}`));
          return;
        }

        // Check content type to make sure we're getting a zip file
        const contentType = response.headers['content-type'];
        if (contentType && !contentType.includes('application/zip') &&
          !contentType.includes('application/octet-stream')) {
          console.warn(`Warning: Expected ZIP file but got ${contentType}`);
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          // Validate the ZIP file
          try {
            // Simple validation: check for ZIP file signature (PK magic number)
            const header = Buffer.alloc(4);
            const fd = fs.openSync(destination, 'r');
            fs.readSync(fd, header, 0, 4, 0);
            fs.closeSync(fd);

            // Check for ZIP signature 'PK\x03\x04'
            if (header[0] !== 0x50 || header[1] !== 0x4B ||
              header[2] !== 0x03 || header[3] !== 0x04) {
              throw new Error('Not a valid ZIP file (missing PK signature)');
            }

            resolve();
          } catch (error) {
            // Delete the invalid file
            try {
              fs.unlinkSync(destination);
            } catch (e) {
              // Ignore error if file can't be deleted
            }
            reject(new Error(`Invalid ZIP file: ${error.message}`));
          }
        });
      }).on('error', (err) => {
        file.close();
        // Delete the file on error
        try {
          fs.unlinkSync(destination);
        } catch (e) {
          // Ignore error if file doesn't exist
        }
        reject(err);
      });
    });
  }

  extractZip(zipPath: string, destPath: string): void {
    try {
      // Validate file exists
      if (!fs.existsSync(zipPath)) {
        throw new Error(`ZIP file not found: ${zipPath}`);
      }

      // Check file size
      const stats = fs.statSync(zipPath);
      if (stats.size < 100) {
        throw new Error(`ZIP file is too small (${stats.size} bytes)`);
      }

      // Extract with better error handling
      try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(destPath, true);
      } catch (error) {
        console.error('Error extracting ZIP file:', error);

        // Try to give more specific error messages
        if (error.message.includes('Invalid LOC header')) {
          throw new Error('ZIP file is corrupted or invalid (Invalid LOC header)');
        } else if (error.message.includes('Invalid central directory')) {
          throw new Error('ZIP file is corrupted (Invalid central directory)');
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('Error extracting ZIP file:', error);
      throw error;
    }
  }

  /**
   * Downloads a repository as a ZIP file and searches it locally
   */
  async fetchIssuesLocally(repo: string, keywords: string[]): Promise<any[]> {
    const [owner, repoName] = repo.split('/');

    if (!owner || !repoName) {
      throw new Error('Invalid repository format. Use "owner/repo"');
    }

    // Check cache for content
    const cacheKey = `${repo}-${keywords.join(',')}`;
    if (this.settings.cacheEnabled && this.cache[cacheKey]) {
      const cacheEntry = this.cache[cacheKey];
      const now = Date.now();
      const expiryTime = this.settings.cacheExpiry * 60 * 1000; // Convert minutes to milliseconds

      // Use cache if not expired
      if (now - cacheEntry.timestamp < expiryTime) {
        console.log('Using cached data for', repo);
        return cacheEntry.data;
      }
    }

    // Create Octokit instance for API calls (we still need some API calls)
    const octokit = this.settings.githubToken
      ? new Octokit({ auth: this.settings.githubToken })
      : new Octokit();

    // Create a subdirectory for this repo
    const repoDir = path.join(this.settings.tempDir, `${owner}-${repoName}`);
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true });
    }

    // Get repository info
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo: repoName,
    });

    // Get default branch
    const defaultBranch = repoData.default_branch;

    // Get latest commit SHA for the default branch
    const { data: branchData } = await octokit.rest.repos.getBranch({
      owner,
      repo: repoName,
      branch: defaultBranch
    });

    const latestCommit = branchData.commit.sha;

    // Check if we already have this repo downloaded and it's up to date
    if (this.repoCache[repo] && this.repoCache[repo].latestCommit === latestCommit) {
      console.log(`Repository ${repo} is already up to date locally`);
    } else {
      console.log(`Downloading repository ${repo}...`);

      // Build the download URL
      const downloadUrl = `https://github.com/${owner}/${repoName}/archive/${defaultBranch}.zip`;

      // Download path
      const downloadPath = path.join(repoDir, `${repoName}-${defaultBranch}.zip`);
      const extractPath = path.join(repoDir, `${repoName}-${defaultBranch}`);

      // Download the ZIP file
      await this.downloadFile(downloadUrl, downloadPath);

      // Extract the ZIP file
      this.extractZip(downloadPath, repoDir);

      // Update repo cache
      this.repoCache[repo] = {
        latestCommit,
        downloadPath,
        extractPath,
        timestamp: Date.now()
      };
    }

    // The extracted directory name will be 'repoName-defaultBranch'
    const searchDir = path.join(repoDir, `${repoName}-${defaultBranch}`);

    // Now search for keywords in the local repository
    const results = [];

    // Walk the directory to find all files
    const walkDir = (dir: string): string[] => {
      const files: string[] = [];
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
          // Skip node_modules and similar directories
          if (['node_modules', '.git', 'build', 'dist', 'target'].includes(item)) {
            continue;
          }
          files.push(...walkDir(itemPath));
        } else if (stat.isFile()) {
          // Include all files regardless of extension - we'll filter by size later
          files.push(itemPath);
        }
      }

      return files;
    };

    // Get all files in the repository
    const files = walkDir(searchDir);

    // Search each file for keywords
    for (const file of files) {
      try {
        // Skip large files
        const stat = fs.statSync(file);
        if (stat.size > 500000) {
          continue;
        }

        // Read file content, skipping if it seems to be binary
        let content;
        try {
          content = fs.readFileSync(file, 'utf8');

          // Skip files that seem to be binary
          if (content.includes('\0') || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]{50,}/.test(content)) {
            continue;
          }
        } catch (readError) {
          // Skip files that can't be read as text
          continue;
        }

        const lines = content.split('\n');

        // Get relative path to create GitHub URL
        const relativePath = path.relative(searchDir, file).replace(/\\/g, '/');

        // Check each line for keywords
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          for (const keyword of keywords) {
            // Look for the keyword in the line (not just keyword:)
            // This is a simple case-insensitive check
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              // Include the next line if available for context
              const nextLine = i + 1 < lines.length ? '\n' + lines[i + 1].trim() : '';

              results.push({
                file: relativePath,
                line: i + 1,
                content: line.trim() + nextLine,
                url: `https://github.com/${owner}/${repoName}/blob/${defaultBranch}/${relativePath}#L${i + 1}`
              });

              // Only match once per line per keyword
              break;
            }
          }
        }
      } catch (error) {
        console.warn(`Error processing file ${file}:`, error);
      }
    }

    console.log(`Found ${results.length} issues in ${repo} locally`);

    // Cache the results if caching is enabled
    if (this.settings.cacheEnabled) {
      this.cache[cacheKey] = {
        timestamp: Date.now(),
        data: results
      };
    }

    return results;
  }
}

class ForFixSakeSettingTab extends PluginSettingTab {
  plugin: ForFixSakePlugin;

  constructor(app: App, plugin: ForFixSakePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'For Fix Sake Settings' });

    // GitHub Token section
    const tokenSetting = new Setting(containerEl)
      .setName('GitHub Token')
      .setDesc('Enter your GitHub personal access token')
      .addText(text => text
        .setPlaceholder('ghp_...')
        .setValue(this.plugin.settings.githubToken)
        .onChange(async (value) => {
          this.plugin.settings.githubToken = value;
          await this.plugin.saveSettings();
        }));

    // Add token creation guide
    const tokenGuide = containerEl.createEl('div', { cls: 'token-guide' });
    tokenGuide.style.backgroundColor = 'var(--background-secondary)';
    tokenGuide.style.padding = '12px';
    tokenGuide.style.borderRadius = '4px';
    tokenGuide.style.marginTop = '8px';
    tokenGuide.style.fontSize = '14px';

    tokenGuide.createEl('h3', { text: 'How to Create a GitHub Token' });

    const steps = tokenGuide.createEl('ol');
    steps.createEl('li', { text: 'Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens' });
    steps.createEl('li', { text: 'Click "Generate new token"' });
    steps.createEl('li', { text: 'Name your token (e.g., "For Fix Sake Obsidian Plugin")' });
    steps.createEl('li', { text: 'Set an expiration date (recommended: 90 days)' });
    steps.createEl('li', { text: 'Under "Repository access", select "Only select repositories" and choose the repositories you want to access' });
    steps.createEl('li', { text: 'Under "Permissions", expand "Repository permissions" and set "Contents" to "Read-only"' });
    steps.createEl('li', { text: 'Click "Generate token" and copy the generated token' });
    steps.createEl('li', { text: 'Paste the token in the field above' });

    // Add note about public repositories
    tokenGuide.createEl('p', {
      text: 'Note: A token is only required for private repositories. Public repositories can be accessed without a token.'
    });

    new Setting(containerEl)
      .setName('Default Keywords')
      .setDesc('Enter default keywords to search for, separated by commas')
      .addText(text => text
        .setPlaceholder('TODO,FIXME')
        .setValue(this.plugin.settings.defaultKeywords.join(','))
        .onChange(async (value) => {
          this.plugin.settings.defaultKeywords = value.split(',').map(k => k.trim());
          await this.plugin.saveSettings();
        }));

    // Cache settings
    new Setting(containerEl)
      .setName('Enable Caching')
      .setDesc('Cache GitHub API requests to reduce rate limiting')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.cacheEnabled)
        .onChange(async (value) => {
          this.plugin.settings.cacheEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Cache Expiry')
      .setDesc('How long to cache results (in minutes)')
      .addSlider(slider => slider
        .setLimits(5, 240, 5)
        .setValue(this.plugin.settings.cacheExpiry)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.cacheExpiry = value;
          await this.plugin.saveSettings();
        }));

    // Local repository settings
    containerEl.createEl('h3', { text: 'Local Repository Settings' });

    new Setting(containerEl)
      .setName('Repository Cache Directory')
      .setDesc('Directory to store downloaded repositories')
      .addText(text => text
        .setPlaceholder(os.tmpdir())
        .setValue(this.plugin.settings.tempDir)
        .onChange(async (value) => {
          this.plugin.settings.tempDir = value || os.tmpdir();
          await this.plugin.saveSettings();

          // Create directory if it doesn't exist
          this.plugin.ensureTempDirExists();
        }));

    // Add button to clear repository cache
    new Setting(containerEl)
      .setName('Clear Repository Cache')
      .setDesc('Delete all downloaded repositories to free up disk space')
      .addButton(button => button
        .setButtonText('Clear Cache')
        .onClick(async () => {
          try {
            // Clear cache if directory exists
            if (fs.existsSync(this.plugin.settings.tempDir)) {
              const files = fs.readdirSync(this.plugin.settings.tempDir);
              for (const file of files) {
                const filePath = path.join(this.plugin.settings.tempDir, file);
                if (fs.lstatSync(filePath).isDirectory()) {
                  // Remove directory recursively
                  fs.rmdirSync(filePath, { recursive: true });
                } else {
                  // Remove file
                  fs.unlinkSync(filePath);
                }
              }

              // Clear repo cache
              this.plugin.repoCache = {};

              new Notice('Repository cache cleared successfully');
            }
          } catch (error) {
            console.error('Failed to clear repository cache:', error);
            new Notice('Failed to clear cache: ' + error.message);
          }
        }));
  }
} 