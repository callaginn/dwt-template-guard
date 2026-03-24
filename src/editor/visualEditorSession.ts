import * as vscode from 'vscode';
import * as path from 'path';
import { ParseCache, parseDocument } from '../parser/dwtParser';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { resolveTemplate } from '../template/templateResolver';
import { resolveTemplatePath } from '../template/templatePathResolver';
import { deriveInstancePath } from '../template/templateUpdater';
import { getNonce } from '../utils/nonce';
import type { PropertiesPanelProvider } from '../properties/propertiesPanelProvider';
import type { SiteServer } from './siteServer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeadRegion {
	name: string;
	content: string;
}

interface HeadRegionWrapper {
	openTag: string;
	closeTag: string;
}

interface WebviewMessage {
	type: string;
	name?: string;
	html?: string;
	value?: string;
}

// ---------------------------------------------------------------------------
// Regex for asset path rewriting (same attributes as templateResolver.ts)
// ---------------------------------------------------------------------------

const ATTR_URL_RE =
	/((?:href|src|action|poster|data|background)\s*=\s*)(["'])([^"']*?)\2/gi;

// ---------------------------------------------------------------------------
// VisualEditorSession
// ---------------------------------------------------------------------------

export class VisualEditorSession {
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly parseCache: ParseCache;
	private readonly stateTracker: DocumentStateTracker;
	private readonly document: vscode.TextDocument;
	private readonly siteRootUri: vscode.Uri;
	private readonly propertiesProvider: PropertiesPanelProvider | undefined;
	private disposables: vscode.Disposable[] = [];
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private updatingFromWebviewCount = 0;
	private lastSentVersion = -1;
	/** CSP nonce — generated once per panel, passed to webview for style injection. */
	private readonly nonce: string;
	/** Maps head region name → the single HTML tag wrapper to re-apply on write-back. */
	private headRegionWrappers = new Map<string, HeadRegionWrapper>();
	/** Extension-hosted static server; undefined when using a BYO server URL. */
	private readonly siteServer: SiteServer | undefined;
	/** Base URL for asset rewriting (extension server or BYO server). */
	private readonly serverUrl: string;

	// ── Constructor ─────────────────────────────────────

	constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		parseCache: ParseCache,
		stateTracker: DocumentStateTracker,
		document: vscode.TextDocument,
		siteRootUri: vscode.Uri,
		serverUrl: string,
		siteServer: SiteServer | undefined,
		propertiesProvider?: PropertiesPanelProvider,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.parseCache = parseCache;
		this.stateTracker = stateTracker;
		this.document = document;
		this.siteRootUri = siteRootUri;
		this.serverUrl = serverUrl;
		this.siteServer = siteServer;
		this.propertiesProvider = propertiesProvider;
		this.nonce = getNonce();

		this.panel.webview.html = this.getHtml(this.panel.webview);

		// Messages from webview
		this.panel.webview.onDidReceiveMessage(
			(msg: WebviewMessage) => this.handleWebviewMessage(msg),
			null,
			this.disposables,
		);

		// Disposal
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		// Pin immediately on creation (panel starts active)
		this.propertiesProvider?.pinDocument(this.document.uri);
		this.propertiesProvider?.setVisualEditor(this);

		// Keep pin in sync as the panel gains/loses focus
		this.panel.onDidChangeViewState(
			({ webviewPanel }) => {
				if (webviewPanel.active) {
					this.propertiesProvider?.pinDocument(this.document.uri);
				} else {
					this.propertiesProvider?.unpinDocument();
				}
			},
			null,
			this.disposables,
		);

		// Source document changes → update webview
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (
					event.document.uri.toString() === this.document.uri.toString() &&
					this.updatingFromWebviewCount === 0
				) {
					this.scheduleRefresh();
				}
			}),
		);

		// Force refresh when a *different* file is saved (e.g. the .dwt template)
		// so the preview picks up external changes. Saving this document itself
		// does not need a forced refresh — onDidChangeTextDocument already handles it.
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (doc.uri.toString() !== this.document.uri.toString()) {
					this.lastSentVersion = -1;
					this.pushContentToWebview();
				}
			}),
		);
	}

	/** The document URI this session is editing. */
	public get uri(): vscode.Uri {
		return this.document.uri;
	}

	/** Immediately push fresh content to the webview (bypasses debounce). */
	public requestRefresh(): void {
		this.lastSentVersion = -1;
		this.pushContentToWebview();
	}

	// ── Rendering pipeline ──────────────────────────────

	private scheduleRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = undefined;
			this.pushContentToWebview();
		}, 300);
	}

	private async pushContentToWebview(): Promise<void> {
		const doc = this.document;

		if (doc.version === this.lastSentVersion) {
			return;
		}

		const parseResult = parseDocument(doc);
		if (!parseResult.templateDeclaration) {
			return;
		}

		// Read the template
		const templateUri = await resolveTemplatePath(
			doc.uri,
			parseResult.templateDeclaration.templatePath,
		);
		if (!templateUri) {
			return;
		}

		let templateBytes: Uint8Array;
		try {
			templateBytes = await vscode.workspace.fs.readFile(templateUri);
		} catch {
			return;
		}
		const templateText = Buffer.from(templateBytes).toString('utf-8');

		// Extract instance data (same pattern as PropertiesPanelProvider)
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

		// Resolve template → full HTML with InstanceBeginEditable markers
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

		// Post-process for webview display
		const { html: wrappedHtml, headRegions } = this.wrapEditableRegions(resolved);
		const rewritten = this.rewritePathsForWebview(wrappedHtml);

		// Split the full HTML document into styles + body content so the
		// webview can inject them properly (innerHTML on a <div> won't
		// process <link> or <style> tags that live inside <head>).
		const { styles, bodyContent, bodyAttrs } = this.extractDocumentParts(rewritten);

		this.panel.webview.postMessage({
			type: 'render',
			styles,
			bodyContent,
			bodyAttrs,
			headRegions,
			nonce: this.nonce,
		});

		this.lastSentVersion = doc.version;
	}

	// ── Editable region wrapping ────────────────────────

	private wrapEditableRegions(html: string): {
		html: string;
		headRegions: HeadRegion[];
	} {
		// Clear stale entries from previous render
		this.headRegionWrappers.clear();

		const headRegions: HeadRegion[] = [];

		// Find </head> position to distinguish head vs body regions
		const headCloseIdx = html.toLowerCase().indexOf('</head>');

		const EDITABLE_RE =
			/<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;

		// Regex to detect a single-element wrapper (e.g. <title>...</title>)
		const SINGLE_ELEM_RE = /^(<([a-z][a-z0-9]*)[^>]*>)([\s\S]*?)(<\/\2>)$/i;

		html = html.replace(EDITABLE_RE, (match, name: string, content: string, offset: number) => {
			if (headCloseIdx !== -1 && offset < headCloseIdx) {
				// Head region → extract for collapsible panel
				const trimmed = content.trim();
				const elemMatch = trimmed.match(SINGLE_ELEM_RE);
				if (elemMatch) {
					// Strip the wrapper tag for display; remember it for write-back
					this.headRegionWrappers.set(name, {
						openTag: elemMatch[1],
						closeTag: elemMatch[4],
					});
					headRegions.push({ name, content: elemMatch[3].trim() });
				} else {
					headRegions.push({ name, content: trimmed });
				}
				return content; // Leave content inline but unwrapped
			} else {
				// Body region → wrap with custom element
				return `<dwt-region data-region="${name}" contenteditable="true">${content}</dwt-region>`;
			}
		});

		// Strip remaining instance markers for clean display
		html = html.replace(/<!--\s*InstanceBegin[\s\S]*?-->/g, '');
		html = html.replace(/^[ \t]*<!--\s*InstanceParam[\s\S]*?-->[ \t]*\r?\n/gm, '');
		html = html.replace(/<!--\s*InstanceParam[\s\S]*?-->/g, '');
		html = html.replace(/<!--\s*InstanceEnd\s*-->/g, '');
		html = html.replace(/<!--\s*InstanceBeginRepeat[\s\S]*?-->/g, '');
		html = html.replace(/<!--\s*InstanceEndRepeat\s*-->/g, '');
		html = html.replace(/<!--\s*InstanceBeginRepeatEntry\s*-->/g, '');
		html = html.replace(/<!--\s*InstanceEndRepeatEntry\s*-->/g, '');

		return { html, headRegions };
	}

	// ── Asset path rewriting for webview ────────────────

	private rewritePathsForWebview(html: string): string {
		const instanceDir = path.dirname(this.document.uri.fsPath);

		ATTR_URL_RE.lastIndex = 0;
		html = html.replace(
			ATTR_URL_RE,
			(match, attr: string, quote: string, url: string) => {
				if (
					!url ||
					url.startsWith('#') ||
					url.startsWith('?') ||
					url.startsWith('data:') ||
					/^[a-z][a-z0-9+.-]*:/i.test(url)
				) {
					return match;
				}

				try {
					const absPath = url.startsWith('/')
						? path.join(this.siteRootUri.fsPath, url)
						: path.resolve(instanceDir, url);
					const rootRelative = path.relative(this.siteRootUri.fsPath, absPath).replace(/\\/g, '/');
					return attr + quote + this.serverUrl + '/' + rootRelative + quote;
				} catch {
					return match;
				}
			},
		);

		return html;
	}

	// ── Document splitting ──────────────────────────────

	/**
	 * Extract <style> and <link rel="stylesheet"> tags from <head>,
	 * and extract <body> inner content, so the webview can inject them
	 * into proper DOM positions.
	 */
	private extractDocumentParts(html: string): {
		styles: string;
		bodyContent: string;
		bodyAttrs: string;
	} {
		// Extract <style>...</style> and <link rel="stylesheet" ...> from <head>
		const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
		let styles = '';
		if (headMatch) {
			const headContent = headMatch[1];
			// Collect <style> blocks
			const styleMatches = headContent.match(/<style[\s\S]*?<\/style>/gi);
			if (styleMatches) {
				styles += styleMatches.join('\n');
			}
			// Collect <link rel="stylesheet" ...> tags
			const linkMatches = headContent.match(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi);
			if (linkMatches) {
				styles += '\n' + linkMatches.join('\n');
			}
		}

		// Extract <body> attributes and inner content
		let bodyContent = html;
		let bodyAttrs = '';
		const bodyOpenMatch = html.match(/<body([^>]*)>/i);
		if (bodyOpenMatch) {
			bodyAttrs = bodyOpenMatch[1] || '';
			const bodyStart = html.indexOf(bodyOpenMatch[0]) + bodyOpenMatch[0].length;
			const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
			if (bodyEnd !== -1) {
				bodyContent = html.slice(bodyStart, bodyEnd);
			} else {
				bodyContent = html.slice(bodyStart);
			}
		}

		return { styles, bodyContent, bodyAttrs };
	}

	// ── Message handling ────────────────────────────────

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.pushContentToWebview();
				break;

			case 'regionChanged':
				if (message.name && message.html !== undefined) {
					await this.writeBackRegion(message.name, message.html);
				}
				break;

			case 'headRegionChanged':
				if (message.name && message.value !== undefined) {
					await this.writeBackHeadRegion(message.name, message.value);
				}
				break;

			case 'focusRegion':
				if (message.name) {
					this.focusRegionInSource(message.name);
				}
				break;

			case 'requestLinkUrl': {
				// prompt() is blocked in webview sandboxes; use the extension host instead
				const url = await vscode.window.showInputBox({
					prompt: 'Enter link URL',
					placeHolder: 'https://',
					validateInput: (v) =>
						v && !v.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('/')
							? 'Enter a valid URL (https://...) or anchor (#section)'
							: null,
				});
				this.panel.webview.postMessage({
					type: 'linkUrl',
					url: url ?? null,
				});
				break;
			}
		}
	}

	// ── Write-back ──────────────────────────────────────

	/**
	 * Find an editable region by name, searching both top-level regions
	 * and those nested inside repeat region entries.
	 */
	private findRegionByName(
		parseResult: ReturnType<typeof parseDocument>,
		regionName: string,
	): import('../parser/types').EditableRegion | undefined {
		const topLevel = parseResult.editableRegions.find(
			(r) => r.name === regionName,
		);
		if (topLevel) {
			return topLevel;
		}
		for (const repeat of parseResult.repeatRegions) {
			for (const entry of repeat.entries) {
				const nested = entry.editableRegions.find(
					(r) => r.name === regionName,
				);
				if (nested) {
					return nested;
				}
			}
		}
		return undefined;
	}

	private async writeBackRegion(
		regionName: string,
		newHtml: string,
	): Promise<void> {
		this.updatingFromWebviewCount++;
		try {
			const doc = this.document;
			const parseResult = parseDocument(doc);
			const region = this.findRegionByName(parseResult, regionName);
			if (!region) {
				return;
			}

			// Skip if content hasn't actually changed
			const currentContent = doc.getText(region.contentRange);
			if (currentContent === newHtml) {
				return;
			}

			const uri = doc.uri.toString();
			this.stateTracker.beginProgrammaticEdit(uri);
			try {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(doc.uri, region.contentRange, newHtml);
				await vscode.workspace.applyEdit(edit);
			} finally {
				this.stateTracker.endProgrammaticEdit(uri);
			}
		} finally {
			this.updatingFromWebviewCount--;
		}
	}

	private async writeBackHeadRegion(
		regionName: string,
		newValue: string,
	): Promise<void> {
		this.updatingFromWebviewCount++;
		try {
			const doc = this.document;
			const parseResult = parseDocument(doc);
			const region = this.findRegionByName(parseResult, regionName);
			if (!region) {
				return;
			}

			const uri = doc.uri.toString();
			const wrapper = this.headRegionWrappers.get(regionName);
			// Derive the indentation of the InstanceBeginEditable marker's own line
			// so the content and end marker stay aligned after write-back.
			const markerLine = doc.lineAt(region.beginMarkerRange.start.line).text;
			const markerIndent = markerLine.match(/^(\s*)/)?.[1] ?? '';
			const contentToWrite = wrapper
				? '\n' + markerIndent + wrapper.openTag + newValue + wrapper.closeTag + '\n' + markerIndent
				: '\n' + newValue + '\n';

			// Skip if content hasn't actually changed
			const currentContent = doc.getText(region.contentRange);
			if (currentContent === contentToWrite) {
				return;
			}

			this.stateTracker.beginProgrammaticEdit(uri);
			try {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(doc.uri, region.contentRange, contentToWrite);
				await vscode.workspace.applyEdit(edit);
			} finally {
				this.stateTracker.endProgrammaticEdit(uri);
			}
		} finally {
			this.updatingFromWebviewCount--;
		}
	}

	// ── Focus region in source editor ───────────────────

	private focusRegionInSource(regionName: string): void {
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === this.document.uri.toString(),
		);
		if (!editor) {
			return;
		}

		const parseResult = this.parseCache.getOrParse(editor.document);
		const region = this.findRegionByName(parseResult, regionName);
		if (!region) {
			return;
		}

		editor.revealRange(
			region.contentRange,
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
		editor.selection = new vscode.Selection(
			region.contentRange.start,
			region.contentRange.start,
		);
	}

	// ── HTML shell ──────────────────────────────────────

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'visual-editor.css'),
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'visual-editor.js'),
		);
		const nonce = this.nonce;
		const srv = this.serverUrl;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource} ${srv} https: 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} ${srv} data: https:; font-src ${srv} https:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${cssUri}" rel="stylesheet" nonce="${nonce}">
	<title>Visual Editor</title>
</head>
<body>
	<div id="toolbar"></div>
	<div id="head-regions"></div>
	<div id="editor-container"></div>
	<div id="region-indicator"></div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	// ── Disposal ────────────────────────────────────────

	dispose(): void {
		this.propertiesProvider?.unpinDocument();
		this.propertiesProvider?.setVisualEditor(undefined);
		this.siteServer?.dispose();
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
