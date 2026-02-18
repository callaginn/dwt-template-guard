import * as vscode from 'vscode';
import { ParseCache } from './parser/dwtParser';
import { DocumentStateTracker } from './protection/documentStateTracker';
import { ProtectionEngine } from './protection/protectionEngine';
import { DecorationManager } from './decoration/decorationManager';
import { PropertiesPanelProvider } from './properties/propertiesPanelProvider';
import { showEditableRegions } from './commands/showEditableRegions';
import { toggleProtection, updateStatusBar } from './commands/toggleProtection';

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

	// Register disposables
	context.subscriptions.push(
		protectionEngine,
		decorationManager,
		statusBarItem,

		vscode.window.registerWebviewViewProvider(
			PropertiesPanelProvider.viewType,
			propertiesProvider,
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

		// Track open/close documents for the protection engine
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) {
				protectionEngine.initDocument(editor.document);
				updateStatusBarVisibility(statusBarItem, editor, parseCache);
			} else {
				statusBarItem.hide();
			}
		}),

		vscode.workspace.onDidOpenTextDocument((doc) => {
			protectionEngine.initDocument(doc);
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
}

export function deactivate(): void {
	// All disposables cleaned up via context.subscriptions
}
