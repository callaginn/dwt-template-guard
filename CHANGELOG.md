# Changelog

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
