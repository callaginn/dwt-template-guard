import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { resolveTemplate } from '../template/templateResolver';
import { resolveTemplatePath } from '../template/templatePathResolver';
import { deriveInstancePath, stripTemplateMarkers } from '../template/templateUpdater';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';
import { dedentBlock } from '../utils/dedent';
import { getNonce } from '../utils/nonce';

interface PanelMessage {
	type: string;
	name?: string;
	value?: string;
	regionName?: string;
	templatePath?: string;
	entryIndex?: number;
	direction?: 'up' | 'down';
}

export class PropertiesPanelProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'dwtTemplateGuard.propertiesPanel';

	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly parseCache: ParseCache,
		private readonly stateTracker: DocumentStateTracker,
	) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
			],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(
			async (message: PanelMessage) => {
				switch (message.type) {
					case 'updateParam':
						if (message.name !== undefined && message.value !== undefined) {
							await this.updateInstanceParam(message.name, message.value);
						}
						break;

					case 'jumpToRegion':
						if (message.regionName) {
							this.jumpToRegion(message.regionName);
						}
						break;

					case 'copyRegion':
						if (message.regionName) {
							await this.copyRegionContents(message.regionName, 'html');
						}
						break;

					case 'copyRegionMarkdown':
						if (message.regionName) {
							await this.copyRegionContents(message.regionName, 'markdown');
						}
						break;

					case 'changeTemplate':
						if (message.templatePath) {
							await this.changeTemplate(message.templatePath);
						}
						break;

					case 'requestTemplates':
						await this.sendAvailableTemplates();
						break;

					case 'ready':
						this.refreshPanel();
						break;

					case 'openTemplate':
						await this.openAttachedTemplate();
						break;

					case 'updatePage':
						await this.updateCurrentPage();
						break;

					case 'detachTemplate':
						await this.detachFromTemplate();
						break;

					case 'exportAllHtml':
						await this.exportAllRegions('html');
						break;

					case 'exportAllMarkdown':
						await this.exportAllRegions('markdown');
						break;

					case 'addRepeatEntry':
						if (message.regionName !== undefined) {
							await this.addRepeatEntry(message.regionName);
						}
						break;

					case 'removeRepeatEntry':
						if (message.regionName !== undefined && message.entryIndex !== undefined) {
							await this.removeRepeatEntry(message.regionName, message.entryIndex);
						}
						break;

					case 'moveRepeatEntry':
						if (message.regionName !== undefined && message.entryIndex !== undefined && message.direction !== undefined) {
							await this.moveRepeatEntry(message.regionName, message.entryIndex, message.direction);
						}
						break;
				}
			},
			null,
			this.disposables,
		);

		// Refresh when the panel becomes visible again
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.scheduleRefresh();
			}
		}, null, this.disposables);

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.scheduleRefresh();
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				const editor = vscode.window.activeTextEditor;
				if (editor && editor.document === event.document) {
					this.scheduleRefresh();
				}
			}),
		);

		// Initial refresh with a small delay to let the webview initialize
		this.scheduleRefresh();
	}

	/** Debounce panel refreshes to avoid excessive updates. */
	private scheduleRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = undefined;
			this.refreshPanel();
		}, 50);
	}

	private refreshPanel(): void {
		if (!this.view || !this.view.visible) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this.view.webview.postMessage({ type: 'clear' });
			return;
		}

		const parseResult = this.parseCache.getOrParse(editor.document);
		// Only show the panel for instance files (files with a template declaration)
		if (!parseResult || parseResult.fileType === 'none' || !parseResult.templateDeclaration) {
			this.view.webview.postMessage({ type: 'clear' });
			return;
		}

		this.view.webview.postMessage({
			type: 'update',
			params: parseResult.instanceParams.map((p) => ({
				name: p.name,
				type: p.type,
				value: p.value,
			})),
			templatePath: parseResult.templateDeclaration.templatePath,
			editableRegions: parseResult.editableRegions.map((r) => r.name),
			optionalRegions: parseResult.optionalRegions.map((r) => r.name),
			repeatRegions: parseResult.repeatRegions.map((r) => ({
				name: r.name,
				entryCount: r.entries.length,
			})),
		});
	}

	// ── Jump to editable region ──────────────────────────

	private jumpToRegion(regionName: string): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = parseResult.editableRegions.find((r) => r.name === regionName);
		if (!region) return;

		editor.revealRange(region.contentRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		editor.selection = new vscode.Selection(
			region.contentRange.start,
			region.contentRange.start,
		);
	}

	// ── Copy editable region contents ────────────────────

	private async copyRegionContents(
		regionName: string,
		format: 'html' | 'markdown',
	): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = parseResult.editableRegions.find((r) => r.name === regionName);
		if (!region) return;

		const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
		const raw = editor.document.getText(region.contentRange);
		const dedented = dedentBlock(raw, tabSize);
		const text = format === 'markdown' ? htmlToMarkdown(dedented) : dedented;
		await vscode.env.clipboard.writeText(text);

		this.view?.webview.postMessage({ type: 'copied', regionName, format });
	}

	// ── Template discovery ───────────────────────────────

	private async sendAvailableTemplates(): Promise<void> {
		if (!this.view) return;

		const templates = await this.findAvailableTemplates();
		this.view.webview.postMessage({
			type: 'templates',
			templates,
		});
	}

	private async findAvailableTemplates(): Promise<string[]> {
		const results: string[] = [];

		// Search for .dwt files across all workspace folders
		const dwtFiles = await vscode.workspace.findFiles('**/Templates/**/*.dwt', '**/node_modules/**', 50);

		for (const uri of dwtFiles) {
			// Convert to site-relative path (e.g. /Templates/Division Page.dwt)
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (folder) {
				const relative = uri.fsPath.slice(folder.uri.fsPath.length);
				results.push(relative.replace(/\\/g, '/'));
			}
		}

		return results.sort();
	}

	// ── Open attached template ───────────────────────────

	private async openAttachedTemplate(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		if (!parseResult.templateDeclaration) return;

		const templateUri = await resolveTemplatePath(
			editor.document.uri,
			parseResult.templateDeclaration.templatePath,
		);
		if (!templateUri) {
			vscode.window.showErrorMessage(
				`Could not find template: ${parseResult.templateDeclaration.templatePath}`,
			);
			return;
		}

		await vscode.window.showTextDocument(templateUri);
	}

	// ── Update current page ──────────────────────────────

	private async updateCurrentPage(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		if (!parseResult.templateDeclaration) return;

		const templateUri = await resolveTemplatePath(
			editor.document.uri,
			parseResult.templateDeclaration.templatePath,
		);
		if (!templateUri) {
			vscode.window.showErrorMessage(
				`Could not find template: ${parseResult.templateDeclaration.templatePath}`,
			);
			return;
		}

		let templateBytes: Uint8Array;
		try {
			templateBytes = await vscode.workspace.fs.readFile(templateUri);
		} catch {
			vscode.window.showErrorMessage(
				`Could not read template: ${parseResult.templateDeclaration.templatePath}`,
			);
			return;
		}
		const templateText = Buffer.from(templateBytes).toString('utf-8');

		const params = new Map<string, string>();
		const paramTypes = new Map<string, string>();
		for (const p of parseResult.instanceParams) {
			params.set(p.name, p.value);
			paramTypes.set(p.name, p.type);
		}

		const editableContents = new Map<string, string>();
		for (const region of parseResult.editableRegions) {
			editableContents.set(
				region.name,
				editor.document.getText(region.contentRange),
			);
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, editor.document.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			editor.document.uri,
			templateUri,
			parseResult.templateDeclaration.templatePath,
		);

		const resolved = resolveTemplate({
			templateText,
			templatePath: parseResult.templateDeclaration.templatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
			instancePath,
			repeatEntries,
		});

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				editor.document.positionAt(0),
				editor.document.positionAt(editor.document.getText().length),
			);
			await editor.edit((editBuilder) => {
				editBuilder.replace(fullRange, resolved);
			});
			vscode.window.showInformationMessage('Page updated from template.');
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	// ── Detach from template ─────────────────────────────

	private async detachFromTemplate(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const answer = await vscode.window.showWarningMessage(
			'Detach from template? This will remove all template markers from the file.',
			{ modal: true },
			'Detach',
		);
		if (answer !== 'Detach') return;

		const text = editor.document.getText();
		const detached = stripTemplateMarkers(text);

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				editor.document.positionAt(0),
				editor.document.positionAt(text.length),
			);
			await editor.edit((editBuilder) => {
				editBuilder.replace(fullRange, detached);
			});
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}


	// ── Export all editable regions ──────────────────────

	private async exportAllRegions(format: 'html' | 'markdown'): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		if (parseResult.editableRegions.length === 0) return;

		const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
		let output = '';
		for (const region of parseResult.editableRegions) {
			const raw = editor.document.getText(region.contentRange).trim();
			const content = dedentBlock(raw, tabSize);
			if (format === 'markdown') {
				output += `## ${region.name}\n\n${htmlToMarkdown(content)}\n\n`;
			} else {
				output += `<!-- ${region.name} -->\n${content}\n\n`;
			}
		}

		const language = format === 'markdown' ? 'markdown' : 'html';
		const doc = await vscode.workspace.openTextDocument({
			content: output.trim(),
			language,
		});
		await vscode.window.showTextDocument(doc);
	}

	// ── Change template ──────────────────────────────────

	private async changeTemplate(newTemplatePath: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		if (!parseResult.templateDeclaration) return;

		// Resolve the new template file
		const templateUri = await resolveTemplatePath(editor.document.uri, newTemplatePath);
		if (!templateUri) {
			vscode.window.showErrorMessage(`Could not find template: ${newTemplatePath}`);
			return;
		}

		let templateBytes: Uint8Array;
		try {
			templateBytes = await vscode.workspace.fs.readFile(templateUri);
		} catch {
			vscode.window.showErrorMessage(`Could not read template: ${newTemplatePath}`);
			return;
		}
		const templateText = Buffer.from(templateBytes).toString('utf-8');

		// Keep current params and editable contents
		const params = new Map<string, string>();
		const paramTypes = new Map<string, string>();
		for (const p of parseResult.instanceParams) {
			params.set(p.name, p.value);
			paramTypes.set(p.name, p.type);
		}

		const editableContents = new Map<string, string>();
		for (const region of parseResult.editableRegions) {
			editableContents.set(
				region.name,
				editor.document.getText(region.contentRange),
			);
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, editor.document.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			editor.document.uri,
			templateUri,
			newTemplatePath,
		);

		const resolved = resolveTemplate({
			templateText,
			templatePath: newTemplatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
			instancePath,
			repeatEntries,
		});

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				editor.document.positionAt(0),
				editor.document.positionAt(editor.document.getText().length),
			);
			await editor.edit((editBuilder) => {
				editBuilder.replace(fullRange, resolved);
			});
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	// ── Update instance param ────────────────────────────

	private async updateInstanceParam(
		name: string,
		newValue: string,
	): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		if (!parseResult) return;

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);

		try {
			const success = await this.tryTemplateReapplication(
				editor, parseResult, name, newValue,
			) || await this.fallbackParamUpdate(editor, parseResult, name, newValue);

			if (!success) {
				vscode.window.showErrorMessage(
					`Failed to update parameter "${name}".`,
				);
			}
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async tryTemplateReapplication(
		editor: vscode.TextEditor,
		parseResult: ReturnType<ParseCache['getOrParse']>,
		changedName: string,
		changedValue: string,
	): Promise<boolean> {
		if (!parseResult.templateDeclaration) return false;

		const templateUri = await resolveTemplatePath(
			editor.document.uri,
			parseResult.templateDeclaration.templatePath,
		);
		if (!templateUri) return false;

		let templateBytes: Uint8Array;
		try {
			templateBytes = await vscode.workspace.fs.readFile(templateUri);
		} catch {
			return false;
		}
		const templateText = Buffer.from(templateBytes).toString('utf-8');

		const params = new Map<string, string>();
		const paramTypes = new Map<string, string>();
		for (const p of parseResult.instanceParams) {
			params.set(p.name, p.name === changedName ? changedValue : p.value);
			paramTypes.set(p.name, p.type);
		}

		const editableContents = new Map<string, string>();
		for (const region of parseResult.editableRegions) {
			editableContents.set(
				region.name,
				editor.document.getText(region.contentRange),
			);
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, editor.document.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			editor.document.uri,
			templateUri,
			parseResult.templateDeclaration.templatePath,
		);

		const resolved = resolveTemplate({
			templateText,
			templatePath: parseResult.templateDeclaration.templatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
			instancePath,
			repeatEntries,
		});

		const fullRange = new vscode.Range(
			editor.document.positionAt(0),
			editor.document.positionAt(editor.document.getText().length),
		);

		return editor.edit((editBuilder) => {
			editBuilder.replace(fullRange, resolved);
		});
	}

	private async fallbackParamUpdate(
		editor: vscode.TextEditor,
		parseResult: ReturnType<ParseCache['getOrParse']>,
		name: string,
		newValue: string,
	): Promise<boolean> {
		const param = parseResult.instanceParams.find((p) => p.name === name);
		if (!param) return false;

		return editor.edit((editBuilder) => {
			editBuilder.replace(param.valueRange, newValue);
		});
	}

	// ── Repeat region entry manipulation ─────────────────

	/**
	 * Returns the full text of an InstanceBeginRepeatEntry...InstanceEndRepeatEntry block
	 * given the repeat region name and zero-based entry index, by looking at the parse result.
	 * If the region has no entries yet (new file), returns the raw inner template block instead.
	 */
	private async addRepeatEntry(regionName: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region) return;

		if (region.entries.length === 0) return; // No entries to duplicate

		// Duplicate the last entry's text
		const lastEntry = region.entries[region.entries.length - 1];
		const entryText = editor.document.getText(lastEntry.fullRange);

		// Insert after the end of the last entry (before InstanceEndRepeat)
		const insertPosition = lastEntry.fullRange.end;

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			await editor.edit((eb) => {
				eb.insert(insertPosition, '\n' + entryText);
			});
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async removeRepeatEntry(regionName: string, entryIndex: number): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region || region.entries.length <= 1) return; // Keep at least one entry

		const entry = region.entries[entryIndex];
		if (!entry) return;

		// Determine range to delete: the entry's full range plus the preceding newline
		const text = editor.document.getText();
		const entryStart = editor.document.offsetAt(entry.fullRange.start);
		const entryEnd = editor.document.offsetAt(entry.fullRange.end);
		// Include the newline before the entry if present
		const deleteStart = entryStart > 0 && text[entryStart - 1] === '\n'
			? entryStart - 1
			: entryStart;

		const deleteRange = new vscode.Range(
			editor.document.positionAt(deleteStart),
			entry.fullRange.end,
		);

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			await editor.edit((eb) => {
				eb.delete(deleteRange);
			});
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async moveRepeatEntry(regionName: string, entryIndex: number, direction: 'up' | 'down'): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region) return;

		const swapIndex = direction === 'up' ? entryIndex - 1 : entryIndex + 1;
		if (swapIndex < 0 || swapIndex >= region.entries.length) return;

		const entryA = region.entries[Math.min(entryIndex, swapIndex)];
		const entryB = region.entries[Math.max(entryIndex, swapIndex)];

		const textA = editor.document.getText(entryA.fullRange);
		const textB = editor.document.getText(entryB.fullRange);

		const uri = editor.document.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			await editor.edit((eb) => {
				// Replace in reverse document order to keep ranges valid
				eb.replace(entryB.fullRange, textA);
				eb.replace(entryA.fullRange, textB);
			});
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	// ── HTML ─────────────────────────────────────────────

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'properties-panel.css'),
		);
		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'properties-panel.js'),
		);
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codiconsUri}" rel="stylesheet">
	<link href="${cssUri}" rel="stylesheet">
	<title>Template Properties</title>
</head>
<body>
	<div id="root">
		<p class="empty-state">Open a Dreamweaver template instance to see properties.</p>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
