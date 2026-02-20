import * as vscode from 'vscode';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { findInstanceFiles, applyTemplateToFile, UpdateResult } from './templateUpdater';
import { getNonce } from '../utils/nonce';

/**
 * A webview panel that shows a list of instance files after a template save,
 * letting the user choose which ones to update.
 */
export class TemplateUpdatePanel {
	private static currentPanel: TemplateUpdatePanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly stateTracker: DocumentStateTracker;
	private disposables: vscode.Disposable[] = [];

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		stateTracker: DocumentStateTracker,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.stateTracker = stateTracker;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.type) {
					case 'update':
						await this.handleUpdate(message.selectedFiles, message.templateData);
						break;
					case 'cancel':
						this.panel.dispose();
						break;
				}
			},
			null,
			this.disposables,
		);
	}

	/**
	 * Show the update modal for a saved template file.
	 * Returns silently if no instance files reference the template.
	 */
	public static async show(
		extensionUri: vscode.Uri,
		templateUri: vscode.Uri,
		stateTracker: DocumentStateTracker,
	): Promise<void> {
		const instanceFiles = await findInstanceFiles(templateUri);

		if (instanceFiles.length === 0) {
			return;
		}

		// Build display list with workspace-relative paths
		const filePaths = instanceFiles.map((f) => ({
			uri: f.uri.toString(),
			templatePath: f.templatePath,
			relativePath: vscode.workspace.asRelativePath(f.uri, false),
		}));

		// Read the template once
		const templateBytes = await vscode.workspace.fs.readFile(templateUri);
		const templateText = Buffer.from(templateBytes).toString('utf-8');

		// Close any existing panel
		if (TemplateUpdatePanel.currentPanel) {
			TemplateUpdatePanel.currentPanel.panel.dispose();
		}

		const panel = vscode.window.createWebviewPanel(
			'dwtTemplateGuard.updateModal',
			'Update Template Instances',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'media'),
					vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
				],
			},
		);

		TemplateUpdatePanel.currentPanel = new TemplateUpdatePanel(
			panel,
			extensionUri,
			stateTracker,
		);

		panel.webview.html = TemplateUpdatePanel.currentPanel.getHtml(panel.webview);

		panel.webview.postMessage({
			type: 'init',
			files: filePaths,
			templateData: {
				templateUri: templateUri.toString(),
				templateText,
			},
		});
	}

	private async handleUpdate(
		selectedFiles: { uri: string; templatePath: string }[],
		templateData: { templateUri: string; templateText: string },
	): Promise<void> {
		const templateUri = vscode.Uri.parse(templateData.templateUri);

		this.panel.dispose();

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Updating template instances...',
				cancellable: false,
			},
			async (progress) => {
				const results: UpdateResult[] = [];
				const total = selectedFiles.length;

				for (let i = 0; i < total; i++) {
					const file = selectedFiles[i];
					const uri = vscode.Uri.parse(file.uri);
					const uriStr = uri.toString();

					this.stateTracker.beginProgrammaticEdit(uriStr);
					try {
						const result = await applyTemplateToFile(
							uri,
							templateUri,
							templateData.templateText,
							file.templatePath,
						);
						results.push(result);
					} finally {
						this.stateTracker.endProgrammaticEdit(uriStr);
					}

					progress.report({
						increment: 100 / total,
						message: `${i + 1} of ${total}`,
					});
				}

				const succeeded = results.filter((r) => r.success).length;
				const failed = results.filter((r) => !r.success);

				if (failed.length === 0) {
					vscode.window.showInformationMessage(
						`Updated ${succeeded} file${succeeded !== 1 ? 's' : ''} from template.`,
					);
				} else {
					vscode.window.showWarningMessage(
						`Updated ${succeeded} file${succeeded !== 1 ? 's' : ''}. ` +
						`${failed.length} failed: ${failed.map((f) => vscode.workspace.asRelativePath(f.uri)).join(', ')}`,
					);
				}
			},
		);
	}

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'update-modal.css'),
		);
		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'update-modal.js'),
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
	<title>Update Template Instances</title>
</head>
<body>
	<div id="root">
		<p class="loading">Searching for instance files...</p>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	private dispose(): void {
		TemplateUpdatePanel.currentPanel = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
