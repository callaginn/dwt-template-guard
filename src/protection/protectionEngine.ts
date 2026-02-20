import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { DocumentStateTracker } from './documentStateTracker';
import { rangeContains } from '../utils/rangeUtils';
import { DEFAULT_FILE_TYPES } from '../constants';

/**
 * Intercepts edits in protected regions and immediately reverts them
 * using the undo command. This preserves a clean undo stack for the user.
 */
export class ProtectionEngine implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly parseCache: ParseCache,
		private readonly stateTracker: DocumentStateTracker,
	) {}

	activate(): void {
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(
				this.onDocumentChange,
				this,
			),
			vscode.workspace.onDidCloseTextDocument((doc) => {
				this.stateTracker.remove(doc.uri.toString());
			}),
		);
	}

	/** Initialize tracking for a document (call when first opened/seen). */
	initDocument(doc: vscode.TextDocument): void {
		const result = this.parseCache.getOrParse(doc);
		this.stateTracker.setLastParseResult(doc.uri.toString(), result);
	}

	private async onDocumentChange(
		event: vscode.TextDocumentChangeEvent,
	): Promise<void> {
		const uri = event.document.uri.toString();

		// Quick exits
		if (!this.isProtectedFileType(event.document)) return;
		if (!this.isProtectionEnabled()) return;
		if (this.stateTracker.isReverting(uri)) return;
		if (this.stateTracker.isProgrammaticEdit(uri)) return;

		// Allow undo/redo to pass through
		if (
			event.reason === vscode.TextDocumentChangeReason.Undo ||
			event.reason === vscode.TextDocumentChangeReason.Redo
		) {
			// After undo/redo, update the stored parse result
			this.stateTracker.setLastParseResult(
				uri,
				this.parseCache.getOrParse(event.document),
			);
			return;
		}

		// Get the parse result from BEFORE this edit
		const parseResult = this.stateTracker.getLastParseResult(uri);
		if (!parseResult || parseResult.fileType === 'none' || !parseResult.templateDeclaration) {
			// Only lock instance files (those with InstanceBegin).
			// Template .dwt files and plain HTML are freely editable.
			this.stateTracker.setLastParseResult(
				uri,
				this.parseCache.getOrParse(event.document),
			);
			return;
		}

		if (parseResult.protectedRegions.length === 0) {
			this.stateTracker.setLastParseResult(
				uri,
				this.parseCache.getOrParse(event.document),
			);
			return;
		}

		// A change is allowed only if it falls entirely within an editable
		// content range.  This is the inverse of checking protected-region
		// overlap and is more robust at boundaries.
		const hasViolation = !event.contentChanges.every((change) =>
			parseResult.editableRegions.some((region) =>
				rangeContains(region.contentRange, change.range),
			),
		);

		if (!hasViolation) {
			// Edit is entirely within editable regions — allow and update parse
			this.parseCache.invalidate(event.document.uri);
			this.stateTracker.setLastParseResult(
				uri,
				this.parseCache.getOrParse(event.document),
			);
			return;
		}

		// Violation: revert the edit
		await this.revertChange(event.document);

		// Show warning
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		if (config.get<boolean>('showWarnings', true)) {
			const message = config.get<string>(
				'warningMessage',
				'This region is protected by the Dreamweaver template. Use "Toggle Protection" to edit.',
			);
			vscode.window.showWarningMessage(message);
		}
	}

	private async revertChange(document: vscode.TextDocument): Promise<void> {
		const uri = document.uri.toString();
		this.stateTracker.beginRevert(uri);

		try {
			// Verify the active editor matches before undoing
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor && activeEditor.document.uri.toString() === uri) {
				await vscode.commands.executeCommand('undo');
			}
		} finally {
			this.stateTracker.endRevert(uri);
		}
	}

	private isProtectedFileType(doc: vscode.TextDocument): boolean {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		const fileTypes = config.get<string[]>('fileTypes', DEFAULT_FILE_TYPES);

		const ext = doc.fileName.split('.').pop()?.toLowerCase();
		return ext !== undefined && fileTypes.includes(ext);
	}

	private isProtectionEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		return config.get<boolean>('enableProtection', true);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
