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
	fromIndex?: number;
	toIndex?: number;
	direction?: 'up' | 'down';
}

export class PropertiesPanelProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'dwtTemplateGuard.propertiesPanel';

	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private pinnedDocumentUri: vscode.Uri | undefined;

	private visualEditor?: import('../editor/visualEditorSession').VisualEditorSession;

	/** Called by the Visual Editor to register/unregister itself. */
	public setVisualEditor(editor: import('../editor/visualEditorSession').VisualEditorSession | undefined): void {
		this.visualEditor = editor;
	}

	/** If the visual editor is open for the given URI, refresh it immediately. */
	private notifyVisualEditor(uri: vscode.Uri): void {
		if (this.visualEditor && this.visualEditor.uri.toString() === uri.toString()) {
			this.visualEditor.requestRefresh();
		}
	}

	/** Called by the Visual Editor when its panel becomes active. */
	public pinDocument(uri: vscode.Uri): void {
		this.pinnedDocumentUri = uri;
		this.scheduleRefresh();
	}

	/** Called by the Visual Editor when its panel loses focus or is disposed. */
	public unpinDocument(): void {
		this.pinnedDocumentUri = undefined;
		this.scheduleRefresh();
	}

	/**
	 * Returns the best available TextEditor for the current context:
	 * the active text editor if one exists, otherwise the first visible
	 * text editor for the pinned document (e.g. when the Visual Editor
	 * panel is focused instead of the source file).
	 */
	private getEffectiveEditor(): vscode.TextEditor | undefined {
		const active = vscode.window.activeTextEditor;
		if (active) {
			return active;
		}
		if (this.pinnedDocumentUri) {
			return vscode.window.visibleTextEditors.find(
				(e) => e.document.uri.toString() === this.pinnedDocumentUri!.toString(),
			);
		}
		return undefined;
	}

	/**
	 * Returns the document URI for the current context — from the active
	 * text editor or the pinned document (visual editor).
	 */
	private getEffectiveDocumentUri(): vscode.Uri | undefined {
		return vscode.window.activeTextEditor?.document.uri ?? this.pinnedDocumentUri;
	}

	/**
	 * Opens (or retrieves) the effective document and parses it.
	 * Works even when no TextEditor is visible (e.g. visual editor only).
	 */
	private async getDocumentAndParse(): Promise<
		{ doc: vscode.TextDocument; parseResult: ReturnType<ParseCache['getOrParse']> } | undefined
	> {
		const uri = this.getEffectiveDocumentUri();
		if (!uri) return undefined;

		let doc: vscode.TextDocument;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch {
			return undefined;
		}
		const parseResult = this.parseCache.getOrParse(doc);
		if (!parseResult) return undefined;
		return { doc, parseResult };
	}

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
						if (message.regionName !== undefined && message.fromIndex !== undefined && message.toIndex !== undefined) {
							await this.moveRepeatEntry(message.regionName, message.fromIndex, message.toIndex);
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
				const editor = this.getEffectiveEditor();
				const isPinnedDoc = this.pinnedDocumentUri &&
					event.document.uri.toString() === this.pinnedDocumentUri.toString();
				if ((editor && editor.document === event.document) || isPinnedDoc) {
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

	private async refreshPanel(): Promise<void> {
		if (!this.view || !this.view.visible) {
			return;
		}

		const editor = this.getEffectiveEditor();
		let doc: vscode.TextDocument | undefined =
			editor?.document ??
			vscode.workspace.textDocuments.find(
				(d) => d.uri.toString() === this.pinnedDocumentUri?.toString(),
			);

		// When the Visual Editor is open without the source tab, the document
		// won't be in textDocuments. Load it into memory without showing a tab.
		if (!doc && this.pinnedDocumentUri) {
			try {
				doc = await vscode.workspace.openTextDocument(this.pinnedDocumentUri);
			} catch {
				// File may have been deleted — fall through to 'clear'
			}
		}

		if (!doc) {
			this.view.webview.postMessage({ type: 'clear' });
			return;
		}

		const parseResult = this.parseCache.getOrParse(doc);
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
		const editor = this.getEffectiveEditor();
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
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		const region = parseResult.editableRegions.find((r) => r.name === regionName);
		if (!region) return;

		const editor = vscode.window.activeTextEditor;
		const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 4;
		const raw = doc.getText(region.contentRange);
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
		// Limit matches findInstanceFiles (5000) so large sites aren't silently truncated
		const dwtFiles = await vscode.workspace.findFiles('**/Templates/**/*.dwt', '**/node_modules/**', 5000);

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
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		if (!parseResult.templateDeclaration) return;

		const templateUri = await resolveTemplatePath(
			doc.uri,
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
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		if (!parseResult.templateDeclaration) return;

		const templateUri = await resolveTemplatePath(
			doc.uri,
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
			editableContents.set(region.name, doc.getText(region.contentRange));
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, doc.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			doc.uri,
			templateUri,
			parseResult.templateDeclaration.templatePath,
		);

		let resolved: string;
		try {
			resolved = resolveTemplate({
				templateText,
				templatePath: parseResult.templateDeclaration.templatePath,
				params,
				paramTypes,
				editableContents,
				codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
				instancePath,
				repeatEntries,
			});
		} catch (err) {
			vscode.window.showErrorMessage(
				`Could not update page: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		if (resolved === doc.getText()) {
			this.view?.webview.postMessage({ type: 'toast', message: 'Page is already up to date.', variant: 'success' });
			return;
		}

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(doc.getText().length),
			);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, fullRange, resolved);
			await vscode.workspace.applyEdit(edit);
			if (doc.isDirty) {
				await doc.save();
			}
			this.notifyVisualEditor(doc.uri);
			vscode.window.showInformationMessage('Page updated from template.');
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	// ── Detach from template ─────────────────────────────

	private async detachFromTemplate(): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc } = ctx;

		const answer = await vscode.window.showWarningMessage(
			'Detach from template? This will remove all template markers from the file.',
			{ modal: true },
			'Detach',
		);
		if (answer !== 'Detach') return;

		const text = doc.getText();
		const detached = stripTemplateMarkers(text);

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(text.length),
			);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, fullRange, detached);
			await vscode.workspace.applyEdit(edit);
			if (doc.isDirty) {
				await doc.save();
			}
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}


	// ── Export all editable regions ──────────────────────

	private async exportAllRegions(format: 'html' | 'markdown'): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		if (parseResult.editableRegions.length === 0) return;

		const editor = vscode.window.activeTextEditor;
		const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 4;
		let output = '';
		for (const region of parseResult.editableRegions) {
			const raw = doc.getText(region.contentRange).trim();
			const content = dedentBlock(raw, tabSize);
			if (format === 'markdown') {
				output += `## ${region.name}\n\n${htmlToMarkdown(content)}\n\n`;
			} else {
				output += `<!-- ${region.name} -->\n${content}\n\n`;
			}
		}

		const language = format === 'markdown' ? 'markdown' : 'html';
		const exportDoc = await vscode.workspace.openTextDocument({
			content: output.trim(),
			language,
		});
		await vscode.window.showTextDocument(exportDoc);
	}

	// ── Change template ──────────────────────────────────

	private async changeTemplate(newTemplatePath: string): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		if (!parseResult.templateDeclaration) return;

		// Resolve the new template file
		const templateUri = await resolveTemplatePath(doc.uri, newTemplatePath);
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
			editableContents.set(region.name, doc.getText(region.contentRange));
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, doc.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			doc.uri,
			templateUri,
			newTemplatePath,
		);

		let resolved: string;
		try {
			resolved = resolveTemplate({
				templateText,
				templatePath: newTemplatePath,
				params,
				paramTypes,
				editableContents,
				codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
				instancePath,
				repeatEntries,
			});
		} catch (err) {
			vscode.window.showErrorMessage(
				`Could not change template: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(doc.getText().length),
			);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, fullRange, resolved);
			await vscode.workspace.applyEdit(edit);
			if (doc.isDirty) {
				await doc.save();
			}
			this.notifyVisualEditor(doc.uri);
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	// ── Update instance param ────────────────────────────

	private async updateInstanceParam(
		name: string,
		newValue: string,
	): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		// Skip entirely if the param already has this value
		const currentParam = parseResult.instanceParams.find((p) => p.name === name);
		if (currentParam && currentParam.value === newValue) {
			return;
		}

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);

		try {
			const success = await this.tryTemplateReapplication(
				doc, parseResult, name, newValue,
			) || await this.fallbackParamUpdate(doc, parseResult, name, newValue);

			if (success) {
				this.notifyVisualEditor(doc.uri);
			} else {
				vscode.window.showErrorMessage(
					`Failed to update parameter "${name}".`,
				);
			}
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async tryTemplateReapplication(
		doc: vscode.TextDocument,
		parseResult: ReturnType<ParseCache['getOrParse']>,
		changedName: string,
		changedValue: string,
	): Promise<boolean> {
		if (!parseResult.templateDeclaration) return false;

		const templateUri = await resolveTemplatePath(
			doc.uri,
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
				doc.getText(region.contentRange),
			);
		}

		const repeatEntries = new Map<string, Map<string, string>[]>();
		for (const region of parseResult.repeatRegions) {
			repeatEntries.set(
				region.name,
				region.entries.map((entry) => {
					const m = new Map<string, string>();
					for (const er of entry.editableRegions) {
						m.set(er.name, doc.getText(er.contentRange));
					}
					return m;
				}),
			);
		}

		const instancePath = deriveInstancePath(
			doc.uri,
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

		const currentText = doc.getText();

		// Skip if resolved output is identical to current content
		if (currentText === resolved) {
			console.log('[DWT] tryTemplateReapplication: SKIP — resolved === current');
			return true;
		}

		// When the resolved output matches the on-disk (saved) content
		// apart from blank-line whitespace, write the saved content instead.
		const normalizeBlankLines = (s: string) => s.replace(/^[ \t]+$/gm, '');
		let contentToWrite = resolved;
		let matchesSavedFile = false;
		try {
			const savedBytes = await vscode.workspace.fs.readFile(doc.uri);
			const savedText = Buffer.from(savedBytes).toString('utf-8');
			if (normalizeBlankLines(resolved) === normalizeBlankLines(savedText)) {
				if (currentText === savedText) {
					return true; // already matches disk
				}
				contentToWrite = savedText;
				matchesSavedFile = true;
			}
		} catch {
			// File may not exist on disk yet — use resolved output
		}

		const fullRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(currentText.length),
		);

		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, fullRange, contentToWrite);
		const result = await vscode.workspace.applyEdit(edit);

		// VS Code tracks dirty state by edit history, not content comparison.
		// applyEdit always marks the doc as modified even if the content now
		// matches what's on disk.  When we restored the saved content, save
		// to clear the dirty flag — the buffer already equals disk so this
		// is a filesystem no-op that just resets the dirty indicator.
		if (result && matchesSavedFile && doc.isDirty) {
			await doc.save();
		}

		return result;
	}

	private async fallbackParamUpdate(
		doc: vscode.TextDocument,
		parseResult: ReturnType<ParseCache['getOrParse']>,
		name: string,
		newValue: string,
	): Promise<boolean> {
		const param = parseResult.instanceParams.find((p) => p.name === name);
		if (!param) return false;

		// Skip if value hasn't actually changed
		if (param.value === newValue) {
			return true;
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, param.valueRange, newValue);
		return vscode.workspace.applyEdit(edit);
	}

	// ── Repeat region entry manipulation ─────────────────

	/**
	 * Returns the full text of an InstanceBeginRepeatEntry...InstanceEndRepeatEntry block
	 * given the repeat region name and zero-based entry index, by looking at the parse result.
	 * If the region has no entries yet (new file), returns the raw inner template block instead.
	 */
	private async addRepeatEntry(regionName: string): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region || region.entries.length === 0) return;

		// Duplicate the last entry's text
		const lastEntry = region.entries[region.entries.length - 1];
		const entryText = doc.getText(lastEntry.fullRange);

		// Insert after the end of the last entry (before InstanceEndRepeat)
		const insertPosition = lastEntry.fullRange.end;

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.insert(doc.uri, insertPosition, '\n' + entryText);
			await vscode.workspace.applyEdit(edit);
			this.notifyVisualEditor(doc.uri);
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async removeRepeatEntry(regionName: string, entryIndex: number): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region || region.entries.length <= 1) return; // Keep at least one entry

		const entry = region.entries[entryIndex];
		if (!entry) return;

		// Determine range to delete: the entry's full range plus the preceding newline
		const text = doc.getText();
		const entryStart = doc.offsetAt(entry.fullRange.start);
		// Include the newline before the entry if present
		const deleteStart = entryStart > 0 && text[entryStart - 1] === '\n'
			? entryStart - 1
			: entryStart;

		const deleteRange = new vscode.Range(
			doc.positionAt(deleteStart),
			entry.fullRange.end,
		);

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.delete(doc.uri, deleteRange);
			await vscode.workspace.applyEdit(edit);
			this.notifyVisualEditor(doc.uri);
		} finally {
			this.stateTracker.endProgrammaticEdit(uri);
		}
	}

	private async moveRepeatEntry(regionName: string, fromIndex: number, toIndex: number): Promise<void> {
		const ctx = await this.getDocumentAndParse();
		if (!ctx) return;
		const { doc, parseResult } = ctx;

		const region = parseResult.repeatRegions.find((r) => r.name === regionName);
		if (!region) return;
		if (fromIndex < 0 || fromIndex >= region.entries.length) return;
		if (toIndex < 0 || toIndex >= region.entries.length) return;
		if (fromIndex === toIndex) return;

		const entryA = region.entries[Math.min(fromIndex, toIndex)];
		const entryB = region.entries[Math.max(fromIndex, toIndex)];

		const textA = doc.getText(entryA.fullRange);
		const textB = doc.getText(entryB.fullRange);

		const uri = doc.uri.toString();
		this.stateTracker.beginProgrammaticEdit(uri);
		try {
			const edit = new vscode.WorkspaceEdit();
			// Replace in reverse document order to keep ranges valid
			edit.replace(doc.uri, entryB.fullRange, textA);
			edit.replace(doc.uri, entryA.fullRange, textB);
			await vscode.workspace.applyEdit(edit);
			this.notifyVisualEditor(doc.uri);
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
