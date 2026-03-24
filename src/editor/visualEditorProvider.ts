import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { resolveTemplatePath } from '../template/templatePathResolver';
import type { PropertiesPanelProvider } from '../properties/propertiesPanelProvider';
import { VisualEditorSession } from './visualEditorSession';
import { startSiteServer } from './siteServer';

export class VisualEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'dwtTemplateGuard.visualEditor';

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly parseCache: ParseCache,
		private readonly stateTracker: DocumentStateTracker,
		private readonly propertiesProvider: PropertiesPanelProvider,
	) {}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const parseResult = this.parseCache.getOrParse(document);
		if (parseResult.fileType !== 'instance' || !parseResult.templateDeclaration) {
			webviewPanel.webview.html = this.getErrorHtml();
			return;
		}

		// Derive site root from template path
		const templateUri = await resolveTemplatePath(
			document.uri,
			parseResult.templateDeclaration.templatePath,
		);
		if (!templateUri) {
			webviewPanel.webview.html = this.getErrorHtml(
				`Could not find template: ${parseResult.templateDeclaration.templatePath}`,
			);
			return;
		}

		const normalizedTemplatePath = parseResult.templateDeclaration.templatePath.replace(/\\/g, '/');
		const siteRoot = templateUri.fsPath.slice(
			0,
			templateUri.fsPath.length - normalizedTemplatePath.length,
		);
		const siteRootUri = vscode.Uri.file(siteRoot);

		// Start a local static file server (or use a BYO server URL)
		const configuredUrl = vscode.workspace
			.getConfiguration('dwtTemplateGuard')
			.get<string>('previewServerUrl', '')
			.trim()
			.replace(/\/$/, '');

		let siteServer;
		let serverUrl: string;
		let serverPort: number | undefined;

		if (configuredUrl) {
			serverUrl = configuredUrl;
			try { serverPort = new URL(configuredUrl).port ? Number(new URL(configuredUrl).port) : undefined; } catch { /* ignore */ }
		} else {
			siteServer = await startSiteServer(siteRoot);
			serverUrl = siteServer.url;
			serverPort = siteServer.port;
		}

		// Configure webview options (panel is already created by VS Code)
		const portMapping = serverPort
			? [{ webviewPort: serverPort, extensionHostPort: serverPort }]
			: [];
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
			portMapping,
		};

		// Create the session (handles rendering, write-back, and lifecycle)
		new VisualEditorSession(
			webviewPanel,
			this.extensionUri,
			this.parseCache,
			this.stateTracker,
			document,
			siteRootUri,
			serverUrl,
			siteServer,
			this.propertiesProvider,
		);
	}

	private getErrorHtml(detail?: string): string {
		const message = detail ?? 'This file is not a Dreamweaver template instance.';
		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);">
<div style="text-align:center;max-width:400px;">
<p>${message}</p>
<p style="opacity:0.7;font-size:0.9em;">Use "Reopen Editor With..." to switch to the default text editor.</p>
</div>
</body></html>`;
	}
}
