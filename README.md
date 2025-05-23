# For Fix Sake - Obsidian Plugin

An Obsidian plugin that helps you track TODOs and FIXMEs from your GitHub repositories with powerful search, filtering, and visualization capabilities.

## Features

- Find and display TODOs, FIXMEs, and other configurable keywords from GitHub repositories
- **Local Repository Analysis**: Downloads repositories and searches locally to avoid API rate limits
- **Smart Grouping**: Group issues by file or keyword
- **Rich Visualization**: Color-coded issues (green for TODOs, red for FIXMEs) and syntax highlighting
- **Advanced Filtering**: Filter results by type (TODO, FIXME, etc.) or search text directly in the rendered view
- **Enhanced Keyword Detection**: Recognizes various TODO formats (TODO, TODO:, // TODO, /* TODO, etc.)
- **Performance Optimized**: Repository caching to minimize downloads and API calls
- **Robust Error Handling**: Graceful handling of network issues and corrupted downloads
- Direct linking to the source code on GitHub
- Simple syntax for embedding in your notes

## Usage

Insert a code block with the `for-fix-sake` language tag in your Obsidian notes:

````
```for-fix-sake
repo: owner/repo-name
keywords: TODO FIXME BUG # optional, defaults to TODO FIXME
```
````

The plugin will:
1. Download the repository (if using local search) or query the GitHub API
2. Scan for your specified keywords
3. Display the results in an organized, filterable view with syntax highlighting

## Advanced Usage

### Keyword Patterns

The plugin recognizes many common patterns for TODOs:
- Standard keywords: `TODO`, `FIXME`, etc.
- Commented keywords: `// TODO`, `/* FIXME */`, `# TODO`, etc.
- Keywords with assignees: `TODO(username)`, `FIXME[john]`, etc.

### Filtering and Visualization

The enhanced UI provides:
- **Instant Filtering**: Type in the filter box to instantly filter results
- **Type Filtering**: Quickly filter by issue type (TODO, FIXME, BUG, etc.)
- **Color-Coding**: Green for TODOs, red for FIXMEs, and other colors for different types of notes
- **File Badges**: Shows file extensions for easy identification
- **Syntax Highlighting**: Code snippets are highlighted for better readability
- **Line Number Badges**: Quickly see which line in the file contains the issue
- **Direct GitHub Links**: Click on filenames to go directly to the code on GitHub

## Configuration

1. Install the plugin
2. Go to Settings > For Fix Sake
3. Enter your GitHub Personal Access Token (instructions provided in settings)
4. Configure default keywords to search for
5. Configure local search settings:
   - Enable/disable local repository search (recommended for better performance)
   - Set cache expiry time for downloaded repositories
   - Configure cache directory for downloaded repositories
   - Clear repository cache when needed

### Local Search with API Fallback

The plugin uses a smart search approach:
- **Local Search** (default): Downloads repositories as ZIP files and searches locally
  - Advantages: Faster, no API rate limits, better results, searches all text files
  - Disadvantages: Requires disk space, larger repositories take longer to download
- **API Search** (fallback): Used only if local search fails
  - Automatically falls back to GitHub's Search API if there are issues with the local search

## Smart Repository Management

The plugin intelligently manages downloaded repositories:
- **Change Detection**: Only re-downloads repositories when changes are detected (via commit SHA)
- **ZIP Validation**: Validates downloaded ZIP files to prevent corruption
- **Binary File Detection**: Automatically skips binary files during local search
- **Error Recovery**: Falls back to API search if local search fails

## Requirements

- Obsidian v0.15.0+
- GitHub Personal Access Token with repo access (only for private repositories)
- Internet connection for downloading repositories or accessing the GitHub API

## Installation

### From Obsidian Community Plugins

1. Open Settings > Community plugins
2. Turn off Safe mode
3. Click Browse community plugins
4. Search for "For Fix Sake"
5. Click Install
6. Enable the plugin in the Community Plugins tab

### Manual Installation

1. Download the latest release
2. Extract the zip file to your Obsidian plugins folder: `<vault>/.obsidian/plugins/`
3. Enable the plugin in Obsidian settings

## Troubleshooting

### GitHub API Rate Limits

If you encounter rate limit errors with the API search:
1. Make sure you've added a GitHub token in the settings
2. Enable local search in the settings (recommended)
3. For very large repositories, consider using more specific keywords

### Repository Download Issues

If you have issues downloading repositories:
1. Check your internet connection
2. Verify you have enough disk space
3. Try clearing the repository cache and downloading again
4. For private repositories, make sure your GitHub token has correct permissions

## Development

1. Clone this repo
2. `npm install`
3. `npm run dev` to start compilation in watch mode

## License

MIT 