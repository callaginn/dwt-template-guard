import * as vscode from 'vscode';
import { DEFAULT_FILE_TYPES } from '../constants';

/** Regex to match the full InstanceBegin comment and capture the template path. */
const INSTANCE_BEGIN_FULL_RE = /<!--\s*InstanceBegin\s+template="([^"]+)"([^>]*?)-->/;

/**
 * When a .dwt file is renamed/moved, update all instance files that reference it
 * so their InstanceBegin template="..." path reflects the new location.
 */
export async function handleTemplateRename(
	oldUri: vscode.Uri,
	newUri: vscode.Uri,
): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

	// Derive what site-relative path oldUri had under each workspace root
	const oldFsPath = oldUri.fsPath.replace(/\\/g, '/');
	const newFsPath = newUri.fsPath.replace(/\\/g, '/');

	// Find workspace-root-relative paths for both old and new URIs
	let oldRelative: string | null = null;
	let newRelative: string | null = null;

	for (const folder of workspaceFolders) {
		const root = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
		if (oldFsPath.startsWith(root + '/')) {
			oldRelative = oldFsPath.slice(root.length); // leading slash preserved
			newRelative = newFsPath.slice(root.length);
			break;
		}
	}

	if (!oldRelative || !newRelative) {
		// Template is not under a workspace folder — nothing we can update
		return;
	}

	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	const fileTypes = config.get<string[]>('fileTypes', DEFAULT_FILE_TYPES);
	const instanceExts = fileTypes.filter((ext) => ext !== 'dwt');
	const globPattern = `**/*.{${instanceExts.join(',')}}`;

	const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 5000);

	const edit = new vscode.WorkspaceEdit();
	let count = 0;

	for (const uri of files) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const head = Buffer.from(bytes.slice(0, 2048)).toString('utf-8');
			const match = INSTANCE_BEGIN_FULL_RE.exec(head);
			if (!match) continue;

			const declaredPath = match[1];
			if (declaredPath.toLowerCase() !== oldRelative.toLowerCase()) continue;

			// Replace the declared path in the full file content
			const fullText = Buffer.from(bytes).toString('utf-8');
			const newText = fullText.replace(
				new RegExp(
					`(<!--\\s*InstanceBegin\\s+template=")${escapeRegExp(declaredPath)}"`,
					'g',
				),
				`$1${newRelative}"`,
			);

			if (newText === fullText) continue;

			// Open the document to get accurate positions from the VS Code model
			// (avoids CRLF character-count errors from computing offsets in raw bytes).
			const doc = await vscode.workspace.openTextDocument(uri);
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(doc.getText().length),
			);
			edit.replace(uri, fullRange, newText);
			count++;
		} catch {
			// Skip unreadable files
		}
	}

	if (count === 0) return;

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		// Save all modified documents
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.isDirty) {
				const uriStr = doc.uri.toString();
				const wasEdited = files.some((f) => f.toString() === uriStr);
				if (wasEdited) {
					await doc.save();
				}
			}
		}
		vscode.window.showInformationMessage(
			`Updated template reference in ${count} file${count !== 1 ? 's' : ''}.`,
		);
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
