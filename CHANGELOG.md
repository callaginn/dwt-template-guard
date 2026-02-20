# Changelog

## 0.1.7 — 2026-02-20

### Added

#### Template Propagation
- **Template Update Panel** — When a `.dwt` file is saved, a webview modal lists every instance file that references it. Select which files to update and apply template changes in one step, with progress reporting and a success/failure summary.
- **Template Updater** (`src/template/templateUpdater.ts`) — Core engine for discovering instance files, applying a template to a single file, and deriving site-relative instance paths for correct relative URL rewriting.
- **Template Rename Handler** — When a `.dwt` file is renamed or moved in the Explorer, all instance files that declare it via `InstanceBegin template="..."` are automatically updated to reflect the new path.
- **New File from Template** — New command (`DWT Guard: New File from Template`) creates a new HTML file from a chosen `.dwt` template, pre-populated with the template's default editable-region content. Accessible from the Explorer context menu on a `.dwt` file or from the command palette.
- **Export Instances to Static HTML** — New command strips all Dreamweaver template markers from every instance file in the workspace and writes clean HTML copies to a user-chosen output folder.

#### Library Item Support
- **Library Item Updater** (`src/library/libraryItemUpdater.ts`) — Mirrors the template propagation system for Dreamweaver Library Items (`.lbi`). Finds all files that reference a given `.lbi` via `#BeginLibraryItem`/`#EndLibraryItem` markers and replaces their content with the updated library item.
- **Library Item Update Panel** — Same modal-based workflow as the template update panel, triggered automatically when a `.lbi` file is saved.
- **LBI Language Registration** — `.lbi` files are now registered as a VS Code language type (`Dreamweaver Library Item`).

#### Editor Intelligence
- **Code Lens** — Displays an inline `Open Template: <path>` lens above the `InstanceBegin` comment in instance files. Clicking it opens the corresponding `.dwt` file. Controllable via the `dwtTemplateGuard.enableCodeLens` setting.
- **Diagnostics** — Shows a `Warning` diagnostic on the `InstanceBegin` line when the declared template path cannot be resolved on disk, surfaced in the Problems panel.

#### Sidebar View
- **Dependency Tree** — A new sidebar panel lists all `.dwt` templates found in the workspace, each expandable to show its instance files. Items are clickable to open the file. Refreshes automatically on template save and can be manually refreshed via `DWT Guard: Refresh Dependency Tree`.

### Changed
- Extracted `DEFAULT_FILE_TYPES` into `src/constants.ts` so the supported file-extension list is shared across the updater, library item updater, and rename handler.
- Added `src/utils/nonce.ts` — shared CSP nonce generator used by both update webview panels.
- `media/update-modal.css` and `media/update-modal.js` added — shared webview frontend for the template and library item update modals.

### Test Site (`test/kevin-registry`)
Expanded the example site to cover real-world scenarios the new features need to handle:
- Added a second template (`Templates/regional.dwt`) to test multi-template workspaces
- Added a `Library/` folder with a reusable library item (`contact-widget.lbi`)
- Added an `about/` subdirectory with nested pages (`index.html`, `history.html`, `leadership.html`) to verify relative URL rewriting across multiple directory levels
- Added `pacific-flyway.html` as an additional top-level instance page
- Updated existing pages (`index.html`, `registry.html`, `kevin-profile.html`, `foia.html`, `bread-log.html`, `missing.html`) to reflect current template and library item structure

---

## 0.1.1 - Added Test Suite

- Fixed test compilation pipeline: added `tsconfig.test.json` and wired test builds into the `compile` script
- All 44 tests passing across 4 suites

## 0.1.0 — Initial Release

### Features

- Edit protection for Dreamweaver template instance files — edits to locked regions are instantly reverted
- Visual highlighting: locked regions are dimmed, editable region markers highlighted in green
- Template Properties sidebar panel with parameter editing, template switching, and region navigation
- Full DWT language support (`.dwt` files) with proper syntax highlighting and Emmet
- Commands: Show Editable Regions, Toggle Protection, Open Template Properties
- Theme-aware colors for light, dark, and high-contrast themes
- Configurable settings for protection, highlighting, warnings, colors, and file types

### Test Suite (44 tests)

- **evaluateCondition** (8 tests) — string equality/inequality, bracket syntax boolean truthiness, bracket syntax string equality, unrecognized condition fallback
- **resolveTemplate** (14 tests) — variable substitution (`@@(ParamName)@@` and bracket syntax), conditional keep/remove, boolean param toggles, editable region content preservation, template defaults vs instance overrides, InstanceBegin/InstanceEnd/InstanceParam insertion, editable regions inside true/false conditionals
- **Range Utilities** (8 tests) — rangeOverlaps and rangeContains with non-overlapping, fully overlapping, partial overlap, adjacent, and identical ranges
- **DWT Parser** (14 tests) — file type detection (template, instance, none), TemplateBeginEditable/TemplateEndEditable parsing, InstanceBeginEditable/InstanceEndEditable parsing, contentRange exclusion of markers, protected region coverage, marker protection, InstanceParam parsing with valueRange, TemplateDeclaration parsing, whole-document protection for non-DWT files
