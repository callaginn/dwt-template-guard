import * as vscode from 'vscode';
import { ParseCache } from '../parser/dwtParser';
import { resolveTemplatePath } from '../template/templatePathResolver';

export const diagnosticCollection = vscode.languages.createDiagnosticCollection('dwtTemplateGuard');

export async function updateDiagnostics(
	doc: vscode.TextDocument,
	parseCache: ParseCache,
): Promise<void> {
	const result = parseCache.getOrParse(doc);

	if (result.fileType !== 'instance' || !result.templateDeclaration) {
		diagnosticCollection.delete(doc.uri);
		return;
	}

	const { templatePath, range } = result.templateDeclaration;
	const resolved = await resolveTemplatePath(doc.uri, templatePath);

	if (resolved === null) {
		const diagnostic = new vscode.Diagnostic(
			range,
			`Cannot resolve template: "${templatePath}"`,
			vscode.DiagnosticSeverity.Warning,
		);
		diagnostic.source = 'DWT Guard';
		diagnosticCollection.set(doc.uri, [diagnostic]);
	} else {
		diagnosticCollection.delete(doc.uri);
	}
}
