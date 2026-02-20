import * as vscode from 'vscode';
import * as path from 'path';
import { resolveTemplate } from './templateResolver';
import { deriveInstancePath } from './templateUpdater';

const TEMPLATE_PARAM_RE =
	/<!--\s*TemplateParam\s+name="([^"]+)"\s+type="([^"]+)"\s+value="([^"]*?)"\s*-->/g;

/**
 * Command: create a new HTML file from a Dreamweaver template.
 * Can be invoked from the explorer context menu (passes a .dwt Uri as arg)
 * or from the command palette (prompts the user to pick a template).
 */
export async function newFileFromTemplate(templateArg?: vscode.Uri): Promise<void> {
	let templateUri: vscode.Uri;

	if (templateArg && templateArg.fsPath.endsWith('.dwt')) {
		templateUri = templateArg;
	} else {
		// Let the user pick from available .dwt files in the workspace
		const dwtFiles = await vscode.workspace.findFiles(
			'**/*.dwt',
			'**/node_modules/**',
			200,
		);
		if (dwtFiles.length === 0) {
			vscode.window.showWarningMessage('No Dreamweaver template (.dwt) files found in the workspace.');
			return;
		}
		const items = dwtFiles.map((uri) => ({
			label: vscode.workspace.asRelativePath(uri, false),
			uri,
		}));
		const picked = await vscode.window.showQuickPick(items, {
			title: 'Select a template',
			placeHolder: 'Choose a .dwt template file',
		});
		if (!picked) return;
		templateUri = picked.uri;
	}

	// Prompt for output file path
	const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const saveUri = await vscode.window.showSaveDialog({
		defaultUri,
		filters: { 'HTML files': ['html', 'htm'] },
		title: 'Save new file',
	});
	if (!saveUri) return;

	// Read the template
	const templateBytes = await vscode.workspace.fs.readFile(templateUri);
	const templateText = Buffer.from(templateBytes).toString('utf-8');

	// Determine site-relative template path
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	let templatePath = '/' + path.basename(templateUri.fsPath);
	for (const folder of workspaceFolders) {
		const folderPath = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
		const tPath = templateUri.fsPath.replace(/\\/g, '/');
		if (tPath.startsWith(folderPath + '/')) {
			templatePath = tPath.slice(folderPath.length);
			break;
		}
	}

	// Parse template params and collect defaults
	const params = new Map<string, string>();
	const paramTypes = new Map<string, string>();
	TEMPLATE_PARAM_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TEMPLATE_PARAM_RE.exec(templateText)) !== null) {
		params.set(m[1], m[3]);
		paramTypes.set(m[1], m[2]);
	}

	// Derive instance path for URL rewriting
	const instancePath = deriveInstancePath(saveUri, templateUri, templatePath);

	// Resolve template with empty editable contents (use template defaults)
	const resolved = resolveTemplate({
		templateText,
		templatePath,
		params,
		paramTypes,
		editableContents: new Map(),
		codeOutsideHTMLIsLocked: true,
		instancePath,
	});

	// Write file and open it
	await vscode.workspace.fs.writeFile(saveUri, Buffer.from(resolved, 'utf-8'));
	const doc = await vscode.workspace.openTextDocument(saveUri);
	await vscode.window.showTextDocument(doc);
}
