# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) (v20 or later)
- [Visual Studio Code](https://code.visualstudio.com/) (v1.85.0 or later)
- [@vscode/vsce](https://github.com/microsoft/vscode-vsce) — required for packaging (`npm install -g @vscode/vsce`)

## Setup

```bash
git clone <repo-url>
cd dwt-template-guard
npm install
npm run check-types   # verify setup
```

## Development

### 1. Running Locally

1. Open the project in VS Code
2. Press **F5** to launch the Extension Development Host (a second VS Code window with your extension loaded from source)
3. The default build task (`npm run watch`) starts automatically as a pre-launch step, so TypeScript recompiles on every save
4. After making changes, press **Cmd+R** (or **Ctrl+R**) in the dev host window to reload and pick up the new build
5. Use the Debug Console in the main window for log output

> To run `npm run watch` standalone (e.g. in a terminal outside VS Code), it runs both `tsc --noEmit --watch` and `esbuild --watch` concurrently.

### 2. Test and Lint

```bash
npm test    # runs tests in a VS Code instance via @vscode/test-electron
npm run lint
```

### 3. Build and Install

| Command | What it does |
|---------|-------------|
| `npm run check-types` | TypeScript type check only (no emit) |
| `npm run vsix` | Production build + package to `releases/dwt-template-guard-x.y.z.vsix` |
| `npm run release` | Interactive: bumps version, builds, packages, and installs the VSIX locally |

`npm run release` is also available via **Tasks: Run Task > Release Extension** in the Command Palette.

### 4. Add to VSCode Marketplace
Create a new publisher and install on the marketplace:
https://marketplace.visualstudio.com/manage

---

## Architecture Notes

- **Parse cache** — results cached by document URI + version to avoid re-parsing on every keystroke
- **Undo-based protection** — protected edits are reverted via VS Code's built-in `undo` command, not manual text manipulation
- **Programmatic edit tracking** — `DocumentStateTracker` flags programmatic edits so the protection engine doesn't revert them
- **Pure template resolver** — `resolveTemplate()` has no VS Code API dependency, making it easy to test
- **Whitespace-aware decorations** — decorations split into non-whitespace sub-ranges so tabs/spaces render with VS Code's default indicators

## Tips

- **Change the dev host project**: add a folder path to the `args` array in `.vscode/launch.json` (e.g. `"${workspaceFolder}/test/kevin-registry"`). Create multiple launch configs for quick switching from the Run and Debug dropdown.
- **Webview CSS/JS changes** (`media/`): run **Developer: Reload Webviews** in the dev host — no recompile needed. Changes to webview *provider* code (`src/properties/`, `src/editor/`) require a full **Cmd+R** reload.
