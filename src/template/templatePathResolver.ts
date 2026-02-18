import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolve a site-relative template path (e.g. "/Templates/Division Page.dwt")
 * to an absolute file URI on disk.
 *
 * Strategy:
 *  1. Try each workspace folder as the site root.
 *  2. Walk up from the instance file's directory looking for a parent that
 *     contains the template path.
 *  3. Return null if nothing found.
 */
export async function resolveTemplatePath(
	instanceUri: vscode.Uri,
	templatePath: string,
): Promise<vscode.Uri | null> {
	// Normalise the template path (strip leading slash for joining)
	const relative = templatePath.replace(/^\//, '');

	// 1. Try workspace folders
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of workspaceFolders) {
		const candidate = vscode.Uri.joinPath(folder.uri, relative);
		if (await fileExists(candidate)) {
			return candidate;
		}
	}

	// 2. Walk up from the instance file
	let dir = vscode.Uri.file(path.dirname(instanceUri.fsPath));
	const root = vscode.Uri.file(path.parse(instanceUri.fsPath).root);

	for (let depth = 0; depth < 20; depth++) {
		const candidate = vscode.Uri.joinPath(dir, relative);
		if (await fileExists(candidate)) {
			return candidate;
		}
		const parent = vscode.Uri.file(path.dirname(dir.fsPath));
		if (parent.fsPath === dir.fsPath || dir.fsPath === root.fsPath) {
			break;
		}
		dir = parent;
	}

	return null;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
