import * as vscode from 'vscode';
import { parseDocument } from '../parser/dwtParser';
import { resolveTemplate } from './templateResolver';
import { resolveTemplatePath } from './templatePathResolver';
import { DEFAULT_FILE_TYPES } from '../constants';

// ── Types ────────────────────────────────────────────

export interface UpdateResult {
	uri: vscode.Uri;
	success: boolean;
	error?: string;
}

// ── Path helpers ─────────────────────────────────────

/**
 * Derive the site-relative path of an instance page (e.g. "/index.html")
 * by subtracting the known site-relative template path from the resolved
 * absolute template URI to find the site root, then computing the
 * instance file's path within that root.
 */
export function deriveInstancePath(
	instanceUri: vscode.Uri,
	templateUri: vscode.Uri,
	templatePath: string,
): string {
	const normalizedTemplatePath = templatePath.replace(/\\/g, '/');
	const siteRoot = templateUri.fsPath.slice(
		0,
		templateUri.fsPath.length - normalizedTemplatePath.length,
	);
	return instanceUri.fsPath
		.slice(siteRoot.length)
		.replace(/\\/g, '/');
}

// ── Instance file discovery ──────────────────────────

/** Regex to extract the template path from an InstanceBegin comment. */
const INSTANCE_BEGIN_RE = /<!--\s*InstanceBegin\s+template="([^"]+)"/;

/**
 * Find all workspace files that are instances of a given template.
 *
 * Rather than matching a specific path string (which breaks when the
 * workspace root differs from the site root), this extracts each file's
 * declared template path and resolves it on disk to see if it points to
 * the same .dwt file that was saved.
 *
 * @param templateUri  The absolute URI of the saved .dwt file.
 */
export async function findInstanceFiles(
	templateUri: vscode.Uri,
): Promise<{ uri: vscode.Uri; templatePath: string }[]> {
	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	const fileTypes = config.get<string[]>('fileTypes', DEFAULT_FILE_TYPES);

	// Exclude .dwt — templates aren't instances of themselves
	const instanceExts = fileTypes.filter((ext) => ext !== 'dwt');
	const globPattern = `**/*.{${instanceExts.join(',')}}`;

	const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 5000);
	const matches: { uri: vscode.Uri; templatePath: string }[] = [];
	const templateFsPath = templateUri.fsPath;

	for (const uri of files) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			// Only check the first 2KB — InstanceBegin is always near the top
			const head = Buffer.from(bytes.slice(0, 2048)).toString('utf-8');
			const match = INSTANCE_BEGIN_RE.exec(head);
			if (!match) continue;

			const declaredPath = match[1];

			// Resolve the declared template path relative to this instance file
			const resolved = await resolveTemplatePath(uri, declaredPath);
			if (resolved && resolved.fsPath === templateFsPath) {
				matches.push({ uri, templatePath: declaredPath });
			}
		} catch {
			// Skip unreadable files
		}
	}

	return matches;
}

// ── Template marker stripping ─────────────────────────

/**
 * Remove all Dreamweaver instance markers from HTML, leaving only the
 * rendered page content. Used for detach and static HTML export.
 */
export function stripTemplateMarkers(text: string): string {
	// Remove InstanceBegin comment
	text = text.replace(/<!--\s*InstanceBegin[\s\S]*?-->/g, '');
	// Remove InstanceParam lines (whole line if alone)
	text = text.replace(/^[ \t]*<!--\s*InstanceParam[\s\S]*?-->[ \t]*\r?\n/gm, '');
	// Fallback for inline InstanceParam
	text = text.replace(/<!--\s*InstanceParam[\s\S]*?-->/g, '');
	// Remove InstanceBeginEditable comments
	text = text.replace(/<!--\s*InstanceBeginEditable[\s\S]*?-->/g, '');
	// Remove InstanceEndEditable comments
	text = text.replace(/<!--\s*InstanceEndEditable\s*-->/g, '');
	// Remove InstanceBeginOptional and InstanceEndOptional comments
	text = text.replace(/<!--\s*InstanceBeginOptional[\s\S]*?-->/g, '');
	text = text.replace(/<!--\s*InstanceEndOptional\s*-->/g, '');
	// Remove InstanceBeginRepeat, InstanceEndRepeat, InstanceBeginRepeatEntry, InstanceEndRepeatEntry
	text = text.replace(/<!--\s*InstanceBeginRepeat[\s\S]*?-->/g, '');
	text = text.replace(/<!--\s*InstanceEndRepeat\s*-->/g, '');
	text = text.replace(/<!--\s*InstanceBeginRepeatEntry\s*-->/g, '');
	text = text.replace(/<!--\s*InstanceEndRepeatEntry\s*-->/g, '');
	// Remove InstanceEnd comment
	text = text.replace(/<!--\s*InstanceEnd\s*-->/g, '');
	// Clean up blank lines left behind
	text = text.replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n');
	return text;
}

// ── Single-file template application ─────────────────

/**
 * Apply a template to a single instance file.
 *
 * Opens the document, parses it, re-resolves the template, and writes
 * the result back. Works for both open and closed files.
 */
export async function applyTemplateToFile(
	instanceUri: vscode.Uri,
	templateUri: vscode.Uri,
	templateText: string,
	templatePath: string,
): Promise<UpdateResult> {
	try {
		const doc = await vscode.workspace.openTextDocument(instanceUri);
		const parseResult = parseDocument(doc);

		if (!parseResult.templateDeclaration) {
			return { uri: instanceUri, success: false, error: 'No template declaration found' };
		}

		// Collect params
		const params = new Map<string, string>();
		const paramTypes = new Map<string, string>();
		for (const p of parseResult.instanceParams) {
			params.set(p.name, p.value);
			paramTypes.set(p.name, p.type);
		}

		// Collect editable region contents
		const editableContents = new Map<string, string>();
		for (const region of parseResult.editableRegions) {
			editableContents.set(region.name, doc.getText(region.contentRange));
		}

		// Collect repeat region entries
		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const entryContents = new Map<string, string>();
					for (const er of entry.editableRegions) {
						entryContents.set(er.name, doc.getText(er.contentRange));
					}
					return entryContents;
				}),
			);
		}

		// Derive instance path for relative URL rewriting
		const instancePath = deriveInstancePath(instanceUri, templateUri, templatePath);

		// Resolve
		const resolved = resolveTemplate({
			templateText,
			templatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
			instancePath,
			repeatEntries,
		});

		// Apply via WorkspaceEdit
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		edit.replace(instanceUri, fullRange, resolved);
		const applied = await vscode.workspace.applyEdit(edit);

		if (applied) {
			// Save if dirty
			const openDoc = vscode.workspace.textDocuments.find(
				(d) => d.uri.toString() === instanceUri.toString(),
			);
			if (openDoc?.isDirty) {
				await openDoc.save();
			}
		}

		return { uri: instanceUri, success: applied };
	} catch (err) {
		return {
			uri: instanceUri,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
