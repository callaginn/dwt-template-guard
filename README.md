# Dreamweaver Template Guard

A Visual Studio Code extension that protects non-editable regions in Dreamweaver template instance files. It prevents accidental modifications to template-locked content while allowing edits only in designated editable regions.

## Features

### Edit Protection

Template instance files (HTML pages with `<!-- InstanceBegin -->` markers) are automatically protected. Edits to locked regions are immediately reverted, and an optional warning message is shown. Template `.dwt` source files and plain HTML are freely editable.

### Visual Highlighting

- Protected (locked) regions are dimmed to look like faded comments
- Editable region markers (`<!-- InstanceBeginEditable -->` / `<!-- InstanceEndEditable -->`) are highlighted in green italic
- Tab and space characters are left untouched so VS Code's "Render Whitespace" indicators display normally
- Colors adapt to light, dark, and high-contrast themes

### Template Properties Panel

A sidebar panel (accessible from the Activity Bar) shows all template properties for the active file:

- **Template selector** &mdash; switch between available `.dwt` templates
- **Instance parameters** &mdash; edit text, color, boolean, number, and URL parameters with appropriate input controls (toggle switches, color swatches, etc.)
- **Editable regions** &mdash; click to jump, copy as HTML or Markdown
- **Template actions** &mdash; open the attached template, re-apply (update) the template, or detach from the template entirely
- **Export** &mdash; export all editable regions as a new HTML or Markdown file

When a parameter value changes, the extension re-applies the `.dwt` template with updated values, resolving `@@(paramName)@@` expressions and `TemplateBeginIf` conditionals while preserving all editable region content.

### DWT Language Support

`.dwt` files are registered as their own language with HTML syntax highlighting. This prevents the HTML/CSS language services from flagging Dreamweaver template expressions (`@@(Division)@@`, `@@(_document['Param'])@@`) as syntax errors. Emmet support is included.

### Commands

All commands are available from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **DWT Guard: Show Editable Regions** | Quick-pick list to jump to any editable region |
| **DWT Guard: Toggle Protection** | Enable or disable edit protection |
| **DWT Guard: Open Template Properties** | Focus the properties panel |

These are also available from the editor right-click context menu and the editor tab context menu for HTML and DWT files.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dwtTemplateGuard.enableProtection` | `true` | Enable edit protection for locked regions |
| `dwtTemplateGuard.enableHighlighting` | `true` | Enable visual dimming of protected regions |
| `dwtTemplateGuard.showWarnings` | `true` | Show a warning when editing a protected region |
| `dwtTemplateGuard.protectedRegionColor` | `null` | Override text color for protected regions (e.g. `#555555`) |
| `dwtTemplateGuard.protectedRegionBackgroundColor` | `null` | Background color for protected regions |
| `dwtTemplateGuard.fileTypes` | `["html","htm","dwt","php","asp","csp"]` | File extensions to activate for |
| `dwtTemplateGuard.warningMessage` | *(default message)* | Custom warning text for protected-region edits |

## Theme Colors

These colors can be customized in your VS Code color theme:

- `dwtTemplateGuard.protectedRegionForeground` &mdash; text color for protected regions
- `dwtTemplateGuard.markerColor` &mdash; text color for editable region marker comments
