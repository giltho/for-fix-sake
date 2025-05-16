# For Fix Sake - Obsidian Plugin

An Obsidian plugin that helps you track TODOs and FIXMEs from your GitHub repositories.

## Features

- Find and display TODOs, FIXMEs, and other configurable keywords from GitHub repositories
- Configurable default keywords
- Direct linking to the source code in GitHub
- Simple syntax for embedding in your notes

## Usage

Insert a code block with the `for-fix-sake` language tag in your Obsidian notes:

```
```for-fix-sake
repo: owner/repo-name
keywords: TODO FIXME # optional, this is the default
```
```

## Configuration

1. Install the plugin
2. Go to Settings > For Fix Sake
3. Enter your GitHub Personal Access Token (instructions provided in settings)
   - Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Click "Generate new token"
   - Name your token (e.g., "For Fix Sake Obsidian Plugin")
   - Set an expiration date (recommended: 90 days)
   - Under "Repository access", select repositories you want to access
   - Under "Repository permissions", set "Contents" to "Read-only"
   - Click "Generate token" and copy it to the plugin settings
4. (Optional) Configure default keywords to search for

## Requirements

- Obsidian v0.15.0+
- GitHub Personal Access Token with repo access (only for private repositories)

## Installation

### From Obsidian

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

## Development

1. Clone this repo
2. `npm install`
3. `npm run dev` to start compilation in watch mode

## License

MIT 