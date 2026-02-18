import * as vscode from 'vscode';

/** The two DWT file variants, or 'none' for files without DWT markers. */
export type DwtFileType = 'template' | 'instance' | 'none';

/** A named editable region with marker and content ranges. */
export interface EditableRegion {
	/** The name= attribute value, e.g. "doctitle" or "Header Text" */
	name: string;
	/** Range covering the opening comment tag */
	beginMarkerRange: vscode.Range;
	/** Range covering the closing comment tag */
	endMarkerRange: vscode.Range;
	/** Range of editable content BETWEEN the markers (exclusive of markers) */
	contentRange: vscode.Range;
	/** Full range from start of begin marker to end of end marker */
	fullRange: vscode.Range;
}

/** A protected (locked) region — everything NOT inside an editable region's contentRange. */
export interface ProtectedRegion {
	range: vscode.Range;
}

/** An InstanceParam declaration parsed from the document. */
export interface InstanceParam {
	name: string;
	type: 'text' | 'color' | 'boolean' | 'number' | 'URL';
	value: string;
	/** The full range of the InstanceParam comment in the document */
	range: vscode.Range;
	/** Range of just the value="..." content (inside the quotes) */
	valueRange: vscode.Range;
}

/** Template declaration from InstanceBegin. */
export interface TemplateDeclaration {
	templatePath: string;
	codeOutsideHTMLIsLocked: boolean;
	range: vscode.Range;
}

/** A template variable reference: @@(variableName)@@ */
export interface TemplateVariable {
	name: string;
	range: vscode.Range;
}

/** A conditional region: TemplateBeginIf/TemplateEndIf */
export interface ConditionalRegion {
	condition: string;
	contentRange: vscode.Range;
	fullRange: vscode.Range;
}

/** Complete parse result for a document. */
export interface DwtParseResult {
	fileType: DwtFileType;
	templateDeclaration: TemplateDeclaration | null;
	editableRegions: EditableRegion[];
	protectedRegions: ProtectedRegion[];
	instanceParams: InstanceParam[];
	templateVariables: TemplateVariable[];
	conditionalRegions: ConditionalRegion[];
}
