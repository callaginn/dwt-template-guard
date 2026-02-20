import * as vscode from 'vscode';
import * as path from 'path';
import { DEFAULT_FILE_TYPES } from '../constants';

/** Regex to extract the .lbi path from a #BeginLibraryItem marker. */
const BEGIN_LBI_RE = /<!--\s*#BeginLibraryItem\s+"([^"]+)"\s*-->/;
const BEGIN_LBI_RE_G = /<!--\s*#BeginLibraryItem\s+"([^"]+)"\s*-->/g;
const END_LBI_RE_G = /<!--\s*#EndLibraryItem\s*-->/g;

export interface LibraryUpdateResult {
	uri: vscode.Uri;
	success: boolean;
	error?: string;
}

/**
 * Find all workspace files that reference a given .lbi library item.
 */
export async function findLibraryItemUsages(
	lbiUri: vscode.Uri,
): Promise<vscode.Uri[]> {
	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	const fileTypes = config.get<string[]>('fileTypes', DEFAULT_FILE_TYPES);

	const globPattern = `**/*.{${fileTypes.join(',')}}`;
	const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 5000);
	const lbiFsPath = lbiUri.fsPath.replace(/\\/g, '/');
	const matches: vscode.Uri[] = [];

	for (const uri of files) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const head = Buffer.from(bytes.slice(0, 4096)).toString('utf-8');
			if (!BEGIN_LBI_RE.test(head)) continue;

			// Check if any reference in this file resolves to this .lbi
			const fullText = Buffer.from(bytes).toString('utf-8');
			BEGIN_LBI_RE_G.lastIndex = 0;
			let m: RegExpExecArray | null;
			let found = false;
			while ((m = BEGIN_LBI_RE_G.exec(fullText)) !== null) {
				// Resolve the site-relative path against workspace folders
				const declaredPath = m[1];
				const resolved = await resolveLbiPath(uri, declaredPath);
				if (resolved && resolved.fsPath.replace(/\\/g, '/') === lbiFsPath) {
					found = true;
					break;
				}
			}
			if (found) {
				matches.push(uri);
			}
		} catch {
			// Skip unreadable files
		}
	}

	return matches;
}

/**
 * Apply updated .lbi content to all matching regions in a file.
 */
export async function applyLibraryItemToFile(
	fileUri: vscode.Uri,
	lbiUri: vscode.Uri,
	lbiText: string,
): Promise<LibraryUpdateResult> {
	try {
		const bytes = await vscode.workspace.fs.readFile(fileUri);
		const text = Buffer.from(bytes).toString('utf-8');

		// Find all matching #BeginLibraryItem/#EndLibraryItem pairs for this lbi
		const lbiFsPath = lbiUri.fsPath.replace(/\\/g, '/');
		const result = await replaceMatchingLbiBlocks(text, fileUri, lbiFsPath, lbiText);

		if (result === text) {
			return { uri: fileUri, success: true }; // No change needed
		}

		const edit = new vscode.WorkspaceEdit();
		const doc = await vscode.workspace.openTextDocument(fileUri);
		const fullRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		edit.replace(fileUri, fullRange, result);
		const applied = await vscode.workspace.applyEdit(edit);

		if (applied) {
			const openDoc = vscode.workspace.textDocuments.find(
				(d) => d.uri.toString() === fileUri.toString(),
			);
			if (openDoc?.isDirty) {
				await openDoc.save();
			}
		}

		return { uri: fileUri, success: applied };
	} catch (err) {
		return {
			uri: fileUri,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Replace the content between all matching #BeginLibraryItem/#EndLibraryItem pairs.
 */
async function replaceMatchingLbiBlocks(
	text: string,
	fileUri: vscode.Uri,
	targetFsPath: string,
	newContent: string,
): Promise<string> {
	// We need to process all occurrences. Build a list of replacement ranges.
	BEGIN_LBI_RE_G.lastIndex = 0;
	END_LBI_RE_G.lastIndex = 0;

	const begins: { path: string; start: number; end: number }[] = [];
	let m: RegExpExecArray | null;

	BEGIN_LBI_RE_G.lastIndex = 0;
	while ((m = BEGIN_LBI_RE_G.exec(text)) !== null) {
		begins.push({ path: m[1], start: m.index, end: m.index + m[0].length });
	}

	const ends: { start: number; end: number }[] = [];
	END_LBI_RE_G.lastIndex = 0;
	while ((m = END_LBI_RE_G.exec(text)) !== null) {
		ends.push({ start: m.index, end: m.index + m[0].length });
	}

	// Pair begins with their nearest following end, filtering to only matching lbi paths
	const replacements: { contentStart: number; contentEnd: number }[] = [];
	let endIdx = 0;

	for (const begin of begins) {
		while (endIdx < ends.length && ends[endIdx].start <= begin.end) {
			endIdx++;
		}
		if (endIdx >= ends.length) break;

		const resolved = await resolveLbiPath(fileUri, begin.path);
		if (resolved && resolved.fsPath.replace(/\\/g, '/') === targetFsPath) {
			replacements.push({
				contentStart: begin.end,
				contentEnd: ends[endIdx].start,
			});
		}
		endIdx++;
	}

	if (replacements.length === 0) return text;

	// Apply replacements from back to front to preserve offsets
	let result = text;
	for (const rep of replacements.reverse()) {
		result = result.slice(0, rep.contentStart) + newContent + result.slice(rep.contentEnd);
	}

	return result;
}

/**
 * Resolve a site-relative .lbi path (e.g. "/Library/widget.lbi")
 * to an absolute URI on disk.
 *
 * Strategy (mirrors resolveTemplatePath):
 *  1. Try each workspace folder as the site root.
 *  2. Walk up from the referencing file's directory looking for a parent
 *     that contains the .lbi path.
 *  3. Return null if nothing found.
 */
async function resolveLbiPath(
	referenceUri: vscode.Uri,
	lbiPath: string,
): Promise<vscode.Uri | null> {
	const relative = lbiPath.replace(/^\//, '');

	// 1. Try workspace folders
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of workspaceFolders) {
		const candidate = vscode.Uri.joinPath(folder.uri, relative);
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch { /* continue */ }
	}

	// 2. Walk up from the referencing file
	let dir = vscode.Uri.file(path.dirname(referenceUri.fsPath));
	const root = vscode.Uri.file(path.parse(referenceUri.fsPath).root);

	for (let depth = 0; depth < 20; depth++) {
		const candidate = vscode.Uri.joinPath(dir, relative);
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch { /* continue */ }
		const parent = vscode.Uri.file(path.dirname(dir.fsPath));
		if (parent.fsPath === dir.fsPath || dir.fsPath === root.fsPath) {
			break;
		}
		dir = parent;
	}

	return null;
}
