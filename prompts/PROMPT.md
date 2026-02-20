I'd like to create a new VSCode extension called "Dreamweaver Template Guard". This extension will protect / lock non-editable regions in files using Dreamweaver's .dwt template syntax.

This extension protects non-editable regions in files that use Adobe Dreamweaver's template system. When you open an HTML or DWT file, the extension scans for Dreamweaver template markers — HTML comments like <!-- InstanceBeginEditable name="content" --> and <!-- InstanceEndEditable --> (or the Template variants). Everything between a begin/end pair is an "editable region"; everything outside those pairs is "protected."

You can refer to DWT_SYNTAX.md for more detailed info about the Dreamweaver templating syntax.

Protected regions are visually dimmed (gray text at low opacity) so you can immediately see which parts of the file you're allowed to change. If you try to type, paste, or delete content in a protected region — including selecting all and deleting — the extension blocks the change, shows a warning message.

The extension adds two commands accessible from the command palette and the right-click context menu: Show Editable Regions opens a quick-pick list that lets you jump directly to any editable region by name, and Toggle Protection lets you temporarily disable protection for the current workspace if you need to make structural changes to the template itself. All behavior is configurable through VS Code settings — you can toggle the visual highlighting, warning messages, and protection on or off independently.

And if possible, I'd like to explore adding a Dreamweaver-like properties panel that allows you to modify any variables within a page.
