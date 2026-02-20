import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { resolveTemplatePath } from '../template/templatePathResolver';

export class TemplateCodeLensProvider implements vscode.CodeLensProvider {
	constructor(private readonly parseCache: ParseCache) {}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
		if (!config.get<boolean>('enableCodeLens', true)) {
			return [];
		}

		const result = this.parseCache.getOrParse(doc);
		if (result.fileType !== 'instance' || !result.templateDeclaration) {
			return [];
		}

		const { templatePath, range } = result.templateDeclaration;

		return [
			new vscode.CodeLens(range, {
				title: `Open Template: ${templatePath}`,
				command: 'dwtTemplateGuard.openAttachedTemplate',
				arguments: [doc.uri, templatePath],
			}),
		];
	}
}

export async function openAttachedTemplate(
	instanceUri: vscode.Uri,
	templatePath: string,
): Promise<void> {
	const resolved = await resolveTemplatePath(instanceUri, templatePath);
	if (!resolved) {
		vscode.window.showWarningMessage(`Cannot find template: "${templatePath}"`);
		return;
	}
	const doc = await vscode.workspace.openTextDocument(resolved);
	await vscode.window.showTextDocument(doc);
}
