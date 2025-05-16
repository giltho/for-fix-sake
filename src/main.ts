import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Octokit } from 'octokit';

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
}

// Define default settings
const DEFAULT_SETTINGS: ForFixSakeSettings = {
  githubToken: '',
  defaultKeywords: ['TODO', 'FIXME']
}

export default class ForFixSakePlugin extends Plugin {
  settings: ForFixSakeSettings;

  async onload() {
    await this.loadSettings();

    // Register for-fix-sake code block processor
    this.registerMarkdownCodeBlockProcessor('for-fix-sake', async (source, el, ctx) => {
      // Parse the code block content
      const lines = source.split('\n');
      let repo = '';
      let keywords = this.settings.defaultKeywords;

      for (const line of lines) {
        if (line.startsWith('repo:')) {
          repo = line.substring('repo:'.length).trim();
        } else if (line.startsWith('keywords:')) {
          const keywordString = line.substring('keywords:'.length).trim();
          // Remove any comments
          const withoutComments = keywordString.split('#')[0].trim();
          keywords = withoutComments.split(/\s+/);
        }
      }

      if (!repo) {
        el.createEl('div', { text: 'Error: No repository specified' });
        return;
      }

      try {
        const issues = await this.fetchIssues(repo, keywords);
        this.renderIssues(issues, el);
      } catch (error) {
        // Check if it might be a private repository access issue
        if (error.status === 404 && !this.settings.githubToken) {
          el.createEl('div', { text: `Error: This may be a private repository. Please configure a GitHub token in the plugin settings.` });
        } else {
          el.createEl('div', { text: `Error fetching issues: ${error.message}` });
        }
      }
    });

    // Add settings tab
    this.addSettingTab(new ForFixSakeSettingTab(this.app, this));
  }

  async fetchIssues(repo: string, keywords: string[]) {
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
      if (file.size > 500000 || !file.name.match(/\.(js|jsx|ts|tsx|py|java|rb|php|c|cpp|h|hpp|cs|go|rs|swift|kt|sh|md|txt)$/i)) {
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

    // Create header
    container.createEl('h3', { text: `Found ${issues.length} issues` });

    // Create issues list
    const list = container.createEl('ul');
    list.style.listStyleType = 'none';
    list.style.padding = '0';

    issues.forEach(issue => {
      const item = list.createEl('li');
      item.style.margin = '8px 0';
      item.style.padding = '8px';
      item.style.backgroundColor = 'var(--background-primary)';
      item.style.borderRadius = '4px';

      // File name with link
      const fileLink = item.createEl('a', {
        text: issue.file,
        href: issue.url
      });
      fileLink.style.fontWeight = 'bold';
      fileLink.style.color = 'var(--interactive-accent)';

      // Line number
      item.createEl('span', {
        text: ` (line ${issue.line})`
      });

      // Issue content
      const content = item.createEl('div');
      content.style.marginTop = '4px';
      content.style.fontFamily = 'var(--font-monospace)';
      content.style.padding = '4px';
      content.style.backgroundColor = 'var(--background-secondary)';
      content.style.borderRadius = '4px';
      content.style.whiteSpace = 'pre-wrap';
      content.textContent = issue.content;
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
  }
} 