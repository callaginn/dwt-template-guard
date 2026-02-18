import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { resolveTemplate } from '../template/templateResolver';
import { resolveTemplatePath } from '../template/templatePathResolver';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';
import { dedentBlock } from '../utils/dedent';

interface PanelMessage {
	type: string;
	name?: string;
	value?: string;
	regionName?: string;
	templatePath?: string;
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
		if (!this.view || !this.view.visible) return;

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

		const resolved = resolveTemplate({
			templateText,
			templatePath: parseResult.templateDeclaration.templatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
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
		const detached = this.stripTemplateMarkers(text);

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

	private stripTemplateMarkers(text: string): string {
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
		// Remove InstanceEnd comment
		text = text.replace(/<!--\s*InstanceEnd\s*-->/g, '');
		// Clean up blank lines left behind
		text = text.replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n');
		return text;
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

		const resolved = resolveTemplate({
			templateText,
			templatePath: newTemplatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
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

		const resolved = resolveTemplate({
			templateText,
			templatePath: parseResult.templateDeclaration.templatePath,
			params,
			paramTypes,
			editableContents,
			codeOutsideHTMLIsLocked: parseResult.templateDeclaration.codeOutsideHTMLIsLocked,
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
		content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
