# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) (v20 or later)
- [Visual Studio Code](https://code.visualstudio.com/) (v1.85.0 or later)

## Setup

```bash
# Clone the repository
git clone <repo-url>
cd dwt-template-protector

# Install dependencies
npm install

# Compile once to verify everything works
npm run compile
```

## Development Workflow

### Watch Mode

Run both the TypeScript type checker and esbuild bundler in parallel, with automatic rebuilds on file changes:

```bash
npm run watch
```

This runs two watchers concurrently:
- `watch:tsc` &mdash; TypeScript type checking (`tsc --noEmit --watch`)
- `watch:esbuild` &mdash; esbuild bundler (`node esbuild.mjs --watch`)

### Debugging

1. Open the project in VS Code
2. Press **F5** to launch the Extension Development Host
3. Open a Dreamweaver template instance file (HTML with `<!-- InstanceBegin -->` markers) to see the extension in action
4. Use the Debug Console for log output

Test files are available in the `test-input/` directory.

### Running Tests

```bash
npm test
```

Tests use `@vscode/test-electron` to run inside a VS Code instance. Test files are located in `test/suite/` and fixtures in `test/fixtures/`.

### Linting

```bash
npm run lint
```

## Project Structure

```
src/
  extension.ts                     Entry point & activation
  parser/
    dwtParser.ts                   DWT file parser & cache
    types.ts                       TypeScript interfaces
  protection/
    protectionEngine.ts            Edit revert logic
    documentStateTracker.ts        Per-document state
  decoration/
    decorationManager.ts           Visual highlighting
  commands/
    showEditableRegions.ts         Quick-pick region list
    toggleProtection.ts            Enable/disable toggle
  properties/
    propertiesPanelProvider.ts     Sidebar webview panel
  template/
    templateResolver.ts            Pure-function template engine
    templatePathResolver.ts        Resolve template file paths
  utils/
    rangeUtils.ts                  Range overlap checks
    htmlToMarkdown.ts              HTML-to-Markdown converter

media/
  properties-panel.js              Webview frontend JS
  properties-panel.css             Webview frontend CSS
  icon.svg                         Extension icon

syntaxes/
  dwt.tmLanguage.json              DWT TextMate grammar

test/
  suite/                           Test files
  fixtures/                        Test fixture files
```

## Build & Package

### Compile (development)

```bash
npm run compile
```

Runs type checking followed by esbuild bundling. Output goes to `dist/extension.js`.

### Package for distribution

```bash
npm run package
```

Runs type checking followed by a production esbuild build (minified, no sourcemaps).

To create a `.vsix` file for distribution:

```bash
# Install vsce if you haven't already
npm install -g @vscode/vsce

# Package the extension
vsce package
```

The `.vscodeignore` file ensures only the compiled `dist/`, `media/`, `syntaxes/`, and config files are included in the package.

## Architecture Notes

- **Parse Cache** &mdash; Parse results are cached by document URI + version to avoid re-parsing on every keystroke
- **Undo-based protection** &mdash; Protected edits are reverted using VS Code's built-in `undo` command rather than manual text manipulation
- **Programmatic edit tracking** &mdash; The `DocumentStateTracker` flags programmatic edits (template re-application, detach) so the protection engine doesn't revert them
- **Template resolver is pure** &mdash; `resolveTemplate()` takes strings in and returns a string out, with no VS Code API dependency, making it straightforward to test
- **Whitespace-aware decorations** &mdash; Decorations are split into non-whitespace sub-ranges so tabs and spaces render with VS Code's default indicators
