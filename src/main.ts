import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Octokit } from 'octokit';

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
        el.createEl('div', { text: `Error fetching issues: ${error.message}` });
      }
    });

    // Add settings tab
    this.addSettingTab(new ForFixSakeSettingTab(this.app, this));
  }

  async fetchIssues(repo: string, keywords: string[]) {
    if (!this.settings.githubToken) {
      throw new Error('GitHub token not configured. Please add it in the plugin settings.');
    }

    const octokit = new Octokit({ auth: this.settings.githubToken });

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
    async function getFilesRecursively(path = '') {
      const { data: contents } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path,
        ref: defaultBranch,
      });

      const files = [];

      for (const item of contents) {
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

      // Skip if not a file with content
      if (!contentData.content) continue;

      // Decode base64 content
      const content = Buffer.from(contentData.content, 'base64').toString();

      // Check for keywords
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const keyword of keywords) {
          if (line.includes(`${keyword}:`)) {
            results.push({
              file: file.path,
              line: i + 1,
              content: line.trim(),
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

    new Setting(containerEl)
      .setName('GitHub Token')
      .setDesc('Enter your GitHub personal access token')
      .addText(text => text
        .setPlaceholder('ghp_...')
        .setValue(this.plugin.settings.githubToken)
        .onChange(async (value) => {
          this.plugin.settings.githubToken = value;
          await this.plugin.saveSettings();
        }));

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