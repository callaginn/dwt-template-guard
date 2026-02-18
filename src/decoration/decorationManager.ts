import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';

export class DecorationManager implements vscode.Disposable {
	private protectedDecorationType: vscode.TextEditorDecorationType;
	private markerDecorationType: vscode.TextEditorDecorationType;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly parseCache: ParseCache) {
		this.protectedDecorationType = this.createProtectedDecorationType();
		this.markerDecorationType = vscode.window.createTextEditorDecorationType({
			color: new vscode.ThemeColor('dwtTemplateGuard.markerColor'),
			fontStyle: 'italic',
		});
	}

	activate(): void {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) this.updateDecorations(editor);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				const editor = vscode.window.activeTextEditor;
				if (editor && editor.document === event.document) {
					this.updateDecorations(editor);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('dwtTemplateGuard')) {
					this.recreateDecorationTypes();
					this.updateAllVisibleEditors();
				}
			}),
		);

		// Decorate all currently visible editors
		this.updateAllVisibleEditors();
	}

	updateDecorations(editor: vscode.TextEditor): void {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		const highlightEnabled = config.get<boolean>('enableHighlighting', true);

		if (!highlightEnabled) {
			editor.setDecorations(this.protectedDecorationType, []);
			editor.setDecorations(this.markerDecorationType, []);
			return;
		}

		const parseResult = this.parseCache.getOrParse(editor.document);
		// Only decorate instance files (those with InstanceBegin).
		// Template .dwt files and plain HTML get no decorations.
		if (parseResult.fileType === 'none' || !parseResult.templateDeclaration) {
			editor.setDecorations(this.protectedDecorationType, []);
			editor.setDecorations(this.markerDecorationType, []);
			return;
		}

		// Gray out non-whitespace text in protected regions.
		// Tab and space characters are skipped so their rendering stays default.
		const protectedRanges = parseResult.protectedRegions.map((r) => r.range);
		editor.setDecorations(
			this.protectedDecorationType,
			this.buildNonWhitespaceRanges(editor.document, protectedRanges),
		);

		// Highlight editable region markers (also skip whitespace)
		const markerRanges = parseResult.editableRegions.flatMap((r) => [
			r.beginMarkerRange,
			r.endMarkerRange,
		]);
		editor.setDecorations(
			this.markerDecorationType,
			this.buildNonWhitespaceRanges(editor.document, markerRanges),
		);
	}

	/**
	 * Split ranges into sub-ranges that exclude tab and space characters.
	 * This prevents decorations from altering whitespace rendering
	 * (dots for spaces, arrows for tabs when "render whitespace" is on).
	 */
	private buildNonWhitespaceRanges(
		doc: vscode.TextDocument,
		ranges: vscode.Range[],
	): vscode.Range[] {
		const result: vscode.Range[] = [];
		const nonWsRegex = /[^ \t]+/g;

		for (const range of ranges) {
			const text = doc.getText(range);
			const baseOffset = doc.offsetAt(range.start);
			nonWsRegex.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = nonWsRegex.exec(text)) !== null) {
				result.push(new vscode.Range(
					doc.positionAt(baseOffset + match.index),
					doc.positionAt(baseOffset + match.index + match[0].length),
				));
			}
		}

		return result;
	}

	private updateAllVisibleEditors(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.updateDecorations(editor);
		}
	}

	private createProtectedDecorationType(): vscode.TextEditorDecorationType {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		const color = config.get<string | null>('protectedRegionColor', null);
		const backgroundColor = config.get<string | null>('protectedRegionBackgroundColor', null);

		return vscode.window.createTextEditorDecorationType({
			color: color ?? new vscode.ThemeColor('dwtTemplateGuard.protectedRegionForeground'),
			...(backgroundColor ? { backgroundColor } : {}),
		});
	}

	private recreateDecorationTypes(): void {
		this.protectedDecorationType.dispose();
		this.protectedDecorationType = this.createProtectedDecorationType();
	}

	dispose(): void {
		this.protectedDecorationType.dispose();
		this.markerDecorationType.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
