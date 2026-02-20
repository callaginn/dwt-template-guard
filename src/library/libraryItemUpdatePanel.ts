import * as vscode from 'vscode';
import { DocumentStateTracker } from '../protection/documentStateTracker';
import { findLibraryItemUsages, applyLibraryItemToFile, LibraryUpdateResult } from './libraryItemUpdater';
import { getNonce } from '../utils/nonce';

/**
 * Webview panel for updating .lbi library item instances,
 * using the same modal UI as the template update panel.
 */
export class LibraryItemUpdatePanel {
	private static currentPanel: LibraryItemUpdatePanel | undefined;
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

	public static async show(
		extensionUri: vscode.Uri,
		lbiUri: vscode.Uri,
		stateTracker: DocumentStateTracker,
	): Promise<void> {
		const usageFiles = await findLibraryItemUsages(lbiUri);

		if (usageFiles.length === 0) {
			return;
		}

		const filePaths = usageFiles.map((uri) => ({
			uri: uri.toString(),
			templatePath: lbiUri.toString(), // Repurpose the field to carry the lbi URI
			relativePath: vscode.workspace.asRelativePath(uri, false),
		}));

		const lbiBytes = await vscode.workspace.fs.readFile(lbiUri);
		const lbiText = Buffer.from(lbiBytes).toString('utf-8');

		if (LibraryItemUpdatePanel.currentPanel) {
			LibraryItemUpdatePanel.currentPanel.panel.dispose();
		}

		const panel = vscode.window.createWebviewPanel(
			'dwtTemplateGuard.lbiUpdateModal',
			'Update Library Item Usages',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'media'),
					vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
				],
			},
		);

		LibraryItemUpdatePanel.currentPanel = new LibraryItemUpdatePanel(
			panel,
			extensionUri,
			stateTracker,
		);

		panel.webview.html = LibraryItemUpdatePanel.currentPanel.getHtml(panel.webview);

		panel.webview.postMessage({
			type: 'init',
			files: filePaths,
			templateData: {
				templateUri: lbiUri.toString(),
				templateText: lbiText,
			},
		});
	}

	private async handleUpdate(
		selectedFiles: { uri: string; templatePath: string }[],
		templateData: { templateUri: string; templateText: string },
	): Promise<void> {
		const lbiUri = vscode.Uri.parse(templateData.templateUri);
		const lbiText = templateData.templateText;

		this.panel.dispose();

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Updating library item usages...',
				cancellable: false,
			},
			async (progress) => {
				const results: LibraryUpdateResult[] = [];
				const total = selectedFiles.length;

				for (let i = 0; i < total; i++) {
					const file = selectedFiles[i];
					const uri = vscode.Uri.parse(file.uri);
					const uriStr = uri.toString();

					this.stateTracker.beginProgrammaticEdit(uriStr);
					try {
						const result = await applyLibraryItemToFile(uri, lbiUri, lbiText);
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
						`Updated library item in ${succeeded} file${succeeded !== 1 ? 's' : ''}.`,
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
	<title>Update Library Item Usages</title>
</head>
<body>
	<div id="root">
		<p class="loading">Searching for library item usages...</p>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	private dispose(): void {
		LibraryItemUpdatePanel.currentPanel = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
