import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';

export async function showEditableRegions(parseCache: ParseCache): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const parseResult = parseCache.getOrParse(editor.document);
	if (parseResult.editableRegions.length === 0) {
		vscode.window.showInformationMessage('No editable regions found in this file.');
		return;
	}

	const items: vscode.QuickPickItem[] = parseResult.editableRegions.map((region) => ({
		label: region.name,
		description: `Line ${region.contentRange.start.line + 1}`,
		detail: editor.document
			.getText(region.contentRange)
			.substring(0, 80)
			.trim()
			.replace(/\s+/g, ' '),
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Jump to editable region...',
		matchOnDescription: true,
		matchOnDetail: true,
	});

	if (selected) {
		const region = parseResult.editableRegions.find(
			(r) => r.name === selected.label,
		);
		if (region) {
			editor.selection = new vscode.Selection(
				region.contentRange.start,
				region.contentRange.start,
			);
			editor.revealRange(
				region.contentRange,
				vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			);
		}
	}
}
