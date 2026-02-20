import * as vscode from 'vscode';
import { ParseCache } from './parser/dwtParser';
import { DocumentStateTracker } from './protection/documentStateTracker';
import { ProtectionEngine } from './protection/protectionEngine';
import { DecorationManager } from './decoration/decorationManager';
import { PropertiesPanelProvider } from './properties/propertiesPanelProvider';
import { showEditableRegions } from './commands/showEditableRegions';
import { toggleProtection, updateStatusBar } from './commands/toggleProtection';
import { TemplateUpdatePanel } from './template/templateUpdatePanel';
import { diagnosticCollection, updateDiagnostics } from './diagnostics/templateDiagnostics';
import { TemplateCodeLensProvider, openAttachedTemplate } from './codelens/templateCodeLens';
import { handleTemplateRename } from './template/templateRenameHandler';
import { stripTemplateMarkers } from './template/templateUpdater';
import { newFileFromTemplate } from './template/newFileFromTemplate';
import { DependencyTreeProvider } from './views/dependencyTreeProvider';
import { LibraryItemUpdatePanel } from './library/libraryItemUpdatePanel';
import * as path from 'path';
import { DEFAULT_FILE_TYPES } from './constants';

export function activate(context: vscode.ExtensionContext): void {
	const parseCache = new ParseCache();
	const stateTracker = new DocumentStateTracker();

	// Core systems
	const protectionEngine = new ProtectionEngine(parseCache, stateTracker);
	const decorationManager = new DecorationManager(parseCache);

	// Properties panel
	const propertiesProvider = new PropertiesPanelProvider(
		context.extensionUri,
		parseCache,
		stateTracker,
	);

	// Status bar
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);

	// Dependency tree
	const dependencyTreeProvider = new DependencyTreeProvider();

	// Register disposables
	context.subscriptions.push(
		protectionEngine,
		decorationManager,
		statusBarItem,
		diagnosticCollection,

		vscode.window.registerWebviewViewProvider(
			PropertiesPanelProvider.viewType,
			propertiesProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.showEditableRegions',
			() => showEditableRegions(parseCache),
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.toggleProtection',
			() => toggleProtection(statusBarItem),
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.openPropertiesPanel',
			() => vscode.commands.executeCommand('dwtTemplateGuard.propertiesPanel.focus'),
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.openAttachedTemplate',
			(instanceUri: vscode.Uri, templatePath: string) =>
				openAttachedTemplate(instanceUri, templatePath),
		),

		vscode.languages.registerCodeLensProvider(
			[{ language: 'html' }, { language: 'php' }, { language: 'dwt' }],
			new TemplateCodeLensProvider(parseCache),
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.exportInstances',
			() => exportInstancesToStaticHtml(),
		),

		vscode.commands.registerCommand(
			'dwtTemplateGuard.newFileFromTemplate',
			(uri?: vscode.Uri) => newFileFromTemplate(uri),
		),

		vscode.window.registerTreeDataProvider('dwtTemplateGuard.dependencyTree', dependencyTreeProvider),
		vscode.commands.registerCommand('dwtTemplateGuard.refreshDependencyTree', () => dependencyTreeProvider.refresh()),

		// Track open/close documents for the protection engine
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) {
				protectionEngine.initDocument(editor.document);
				updateStatusBarVisibility(statusBarItem, editor, parseCache);
				updateDiagnostics(editor.document, parseCache);
			} else {
				statusBarItem.hide();
				vscode.commands.executeCommand('setContext', 'dwtTemplateGuard.isTemplateInstance', false);
			}
		}),

		vscode.workspace.onDidOpenTextDocument((doc) => {
			protectionEngine.initDocument(doc);
			updateDiagnostics(doc, parseCache);
		}),

		vscode.workspace.onDidCloseTextDocument((doc) => {
			diagnosticCollection.delete(doc.uri);
			parseCache.invalidate(doc.uri);
		}),

		// When a .dwt template is renamed/moved, update InstanceBegin references
		vscode.workspace.onDidRenameFiles(async (event) => {
			for (const { oldUri, newUri } of event.files) {
				if (newUri.fsPath.endsWith('.dwt')) {
					await handleTemplateRename(oldUri, newUri);
				}
			}
		}),

		// When a .dwt template is saved, offer to update all instance files and refresh tree
		vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (doc.fileName.endsWith('.dwt')) {
				dependencyTreeProvider.refresh();
				await TemplateUpdatePanel.show(context.extensionUri, doc.uri, stateTracker);
			} else if (doc.fileName.endsWith('.lbi')) {
				await LibraryItemUpdatePanel.show(context.extensionUri, doc.uri, stateTracker);
			}
		}),
	);

	// Activate subsystems
	protectionEngine.activate();
	decorationManager.activate();

	// Initialize for currently active editor
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		protectionEngine.initDocument(activeEditor.document);
		updateStatusBarVisibility(statusBarItem, activeEditor, parseCache);
	}

	// Initialize all visible editors
	for (const editor of vscode.window.visibleTextEditors) {
		protectionEngine.initDocument(editor.document);
	}

	// Initialize protection status
	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	updateStatusBar(statusBarItem, config.get<boolean>('enableProtection', true));
}

function updateStatusBarVisibility(
	statusBarItem: vscode.StatusBarItem,
	editor: vscode.TextEditor,
	parseCache: ParseCache,
): void {
	const result = parseCache.getOrParse(editor.document);
	if (result.fileType !== 'none') {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		updateStatusBar(statusBarItem, config.get<boolean>('enableProtection', true));
	} else {
		statusBarItem.hide();
	}

	// Enable/disable the Edit menu item based on whether this is a template instance
	vscode.commands.executeCommand(
		'setContext',
		'dwtTemplateGuard.isTemplateInstance',
		result.fileType === 'instance',
	);
}

async function exportInstancesToStaticHtml(): Promise<void> {
	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	const fileTypes = config.get<string[]>('fileTypes', DEFAULT_FILE_TYPES);
	const instanceExts = fileTypes.filter((ext) => ext !== 'dwt');
	const globPattern = `**/*.{${instanceExts.join(',')}}`;

	// Find all instance files (those with InstanceBegin marker)
	const INSTANCE_BEGIN_RE = /<!--\s*InstanceBegin\s+template="/;
	const allFiles = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 5000);
	const instanceFiles: vscode.Uri[] = [];
	for (const uri of allFiles) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const head = Buffer.from(bytes.slice(0, 2048)).toString('utf-8');
			if (INSTANCE_BEGIN_RE.test(head)) {
				instanceFiles.push(uri);
			}
		} catch { /* skip */ }
	}

	if (instanceFiles.length === 0) {
		vscode.window.showInformationMessage('No template instance files found in the workspace.');
		return;
	}

	// Prompt for output folder
	const folders = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Export Here',
		title: 'Select output folder for static HTML export',
	});
	if (!folders || folders.length === 0) return;

	const outputFolder = folders[0];
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Exporting static HTML...',
			cancellable: false,
		},
		async (progress) => {
			let succeeded = 0;
			let failed = 0;
			const total = instanceFiles.length;

			for (let i = 0; i < total; i++) {
				const uri = instanceFiles[i];
				progress.report({ increment: 100 / total, message: `${i + 1} of ${total}` });

				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					const text = Buffer.from(bytes).toString('utf-8');
					const stripped = stripTemplateMarkers(text);

					// Compute relative path within workspace
					let relativePath = vscode.workspace.asRelativePath(uri, false);
					// Strip the leading workspace folder name if present
					for (const folder of workspaceFolders) {
						const folderName = path.basename(folder.uri.fsPath);
						if (relativePath.startsWith(folderName + '/') || relativePath.startsWith(folderName + '\\')) {
							relativePath = relativePath.slice(folderName.length + 1);
							break;
						}
					}

					const outUri = vscode.Uri.joinPath(outputFolder, relativePath);
					// Ensure parent directory exists
					const parentUri = vscode.Uri.file(path.dirname(outUri.fsPath));
					await vscode.workspace.fs.createDirectory(parentUri);
					await vscode.workspace.fs.writeFile(outUri, Buffer.from(stripped, 'utf-8'));
					succeeded++;
				} catch {
					failed++;
				}
			}

			if (failed === 0) {
				vscode.window.showInformationMessage(
					`Exported ${succeeded} file${succeeded !== 1 ? 's' : ''} to ${outputFolder.fsPath}`,
				);
			} else {
				vscode.window.showWarningMessage(
					`Exported ${succeeded} file${succeeded !== 1 ? 's' : ''}. ${failed} failed.`,
				);
			}
		},
	);
}

export function deactivate(): void {
	// All disposables cleaned up via context.subscriptions
}
