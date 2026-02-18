import * as vscode from 'vscode';
import {
	DwtFileType,
	DwtParseResult,
	EditableRegion,
	ProtectedRegion,
	InstanceParam,
	TemplateDeclaration,
	TemplateVariable,
	ConditionalRegion,
} from './types';

// --- Regex patterns ---

// Editable region markers (Template variant — used in .dwt files)
const TEMPLATE_BEGIN_EDITABLE = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->/g;
const TEMPLATE_END_EDITABLE = /<!--\s*TemplateEndEditable\s*-->/g;

// Editable region markers (Instance variant — used in .html pages)
const INSTANCE_BEGIN_EDITABLE = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->/g;
const INSTANCE_END_EDITABLE = /<!--\s*InstanceEndEditable\s*-->/g;

// Template declaration
const INSTANCE_BEGIN = /<!--\s*InstanceBegin\s+template="([^"]+)"(?:\s+codeOutsideHTMLIsLocked="([^"]+)")?\s*-->/g;

// Instance parameters
const INSTANCE_PARAM = /<!--\s*InstanceParam\s+name="([^"]+)"\s+type="([^"]+)"\s+value="([^"]*?)"\s*-->/g;

// Template variable output
const TEMPLATE_VARIABLE = /@@\(([^)]+)\)@@/g;

// Conditional regions
const TEMPLATE_BEGIN_IF = /<!--\s*TemplateBeginIf\s+cond="([^"]+)"\s*-->/g;
const TEMPLATE_END_IF = /<!--\s*TemplateEndIf\s*-->/g;

/** Determine whether this file is a template, instance, or neither. */
function detectFileType(text: string): DwtFileType {
	if (/<!--\s*InstanceBegin\s/.test(text) || /<!--\s*InstanceBeginEditable\s/.test(text)) {
		return 'instance';
	}
	if (/<!--\s*TemplateBeginEditable\s/.test(text)) {
		return 'template';
	}
	return 'none';
}

interface MarkerMatch {
	name: string;
	start: number;
	end: number;
}

/** Find all matches for a begin-editable regex, returning name + offsets. */
function findBeginMarkers(regex: RegExp, text: string): MarkerMatch[] {
	const results: MarkerMatch[] = [];
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		results.push({
			name: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return results;
}

/** Find all matches for an end-editable regex, returning offsets. */
function findEndMarkers(regex: RegExp, text: string): { start: number; end: number }[] {
	const results: { start: number; end: number }[] = [];
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		results.push({
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return results;
}

/** Parse editable regions by pairing begin/end markers in document order. */
function parseEditableRegions(
	doc: vscode.TextDocument,
	text: string,
	beginRegex: RegExp,
	endRegex: RegExp,
): EditableRegion[] {
	const begins = findBeginMarkers(beginRegex, text);
	const ends = findEndMarkers(endRegex, text);

	const regions: EditableRegion[] = [];
	let endIdx = 0;

	for (const begin of begins) {
		// Find the next end marker that comes after this begin marker
		while (endIdx < ends.length && ends[endIdx].start < begin.end) {
			endIdx++;
		}
		if (endIdx >= ends.length) break;

		const end = ends[endIdx];
		endIdx++;

		const beginMarkerRange = new vscode.Range(
			doc.positionAt(begin.start),
			doc.positionAt(begin.end),
		);
		const endMarkerRange = new vscode.Range(
			doc.positionAt(end.start),
			doc.positionAt(end.end),
		);
		const contentRange = new vscode.Range(
			doc.positionAt(begin.end),
			doc.positionAt(end.start),
		);
		const fullRange = new vscode.Range(
			doc.positionAt(begin.start),
			doc.positionAt(end.end),
		);

		regions.push({
			name: begin.name,
			beginMarkerRange,
			endMarkerRange,
			contentRange,
			fullRange,
		});
	}

	return regions;
}

/** Compute protected regions as the complement of editable contentRanges. */
function computeProtectedRegions(
	doc: vscode.TextDocument,
	editableRegions: EditableRegion[],
): ProtectedRegion[] {
	if (editableRegions.length === 0) {
		// Entire document is protected
		const docRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		return [{ range: docRange }];
	}

	const protected_: ProtectedRegion[] = [];
	const docStart = doc.positionAt(0);
	const docEnd = doc.positionAt(doc.getText().length);

	// Sort by start position
	const sorted = [...editableRegions].sort((a, b) =>
		a.contentRange.start.compareTo(b.contentRange.start),
	);

	// Gap before first editable region
	if (sorted[0].contentRange.start.isAfter(docStart)) {
		const range = new vscode.Range(docStart, sorted[0].contentRange.start);
		if (!range.isEmpty) {
			protected_.push({ range });
		}
	}

	// Gaps between consecutive editable regions
	for (let i = 0; i < sorted.length - 1; i++) {
		const gapStart = sorted[i].contentRange.end;
		const gapEnd = sorted[i + 1].contentRange.start;
		if (gapEnd.isAfter(gapStart)) {
			protected_.push({ range: new vscode.Range(gapStart, gapEnd) });
		}
	}

	// Gap after last editable region
	const lastEnd = sorted[sorted.length - 1].contentRange.end;
	if (docEnd.isAfter(lastEnd)) {
		const range = new vscode.Range(lastEnd, docEnd);
		if (!range.isEmpty) {
			protected_.push({ range });
		}
	}

	return protected_;
}

/** Parse InstanceParam tags. */
function parseInstanceParams(doc: vscode.TextDocument, text: string): InstanceParam[] {
	const results: InstanceParam[] = [];
	INSTANCE_PARAM.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = INSTANCE_PARAM.exec(text)) !== null) {
		const fullStart = match.index;
		const fullEnd = fullStart + match[0].length;

		// Find the value="..." portion within the match
		const valueAttrPattern = /value="([^"]*?)"/;
		const valueMatch = valueAttrPattern.exec(match[0]);
		let valueRange: vscode.Range;

		if (valueMatch) {
			const valueContentStart = fullStart + valueMatch.index + 'value="'.length;
			const valueContentEnd = valueContentStart + valueMatch[1].length;
			valueRange = new vscode.Range(
				doc.positionAt(valueContentStart),
				doc.positionAt(valueContentEnd),
			);
		} else {
			// Fallback: use full range
			valueRange = new vscode.Range(doc.positionAt(fullStart), doc.positionAt(fullEnd));
		}

		results.push({
			name: match[1],
			type: match[2] as InstanceParam['type'],
			value: match[3],
			range: new vscode.Range(doc.positionAt(fullStart), doc.positionAt(fullEnd)),
			valueRange,
		});
	}

	return results;
}

/** Parse InstanceBegin template declaration. */
function parseTemplateDeclaration(doc: vscode.TextDocument, text: string): TemplateDeclaration | null {
	INSTANCE_BEGIN.lastIndex = 0;
	const match = INSTANCE_BEGIN.exec(text);
	if (!match) return null;

	return {
		templatePath: match[1],
		codeOutsideHTMLIsLocked: match[2] !== 'false',
		range: new vscode.Range(
			doc.positionAt(match.index),
			doc.positionAt(match.index + match[0].length),
		),
	};
}

/** Parse @@(variableName)@@ references. */
function parseTemplateVariables(doc: vscode.TextDocument, text: string): TemplateVariable[] {
	const results: TemplateVariable[] = [];
	TEMPLATE_VARIABLE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TEMPLATE_VARIABLE.exec(text)) !== null) {
		results.push({
			name: match[1],
			range: new vscode.Range(
				doc.positionAt(match.index),
				doc.positionAt(match.index + match[0].length),
			),
		});
	}

	return results;
}

/** Parse TemplateBeginIf/TemplateEndIf conditional regions. */
function parseConditionalRegions(doc: vscode.TextDocument, text: string): ConditionalRegion[] {
	const begins: { condition: string; start: number; end: number }[] = [];
	TEMPLATE_BEGIN_IF.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TEMPLATE_BEGIN_IF.exec(text)) !== null) {
		begins.push({
			condition: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	const ends = findEndMarkers(TEMPLATE_END_IF, text);
	const regions: ConditionalRegion[] = [];
	let endIdx = 0;

	for (const begin of begins) {
		while (endIdx < ends.length && ends[endIdx].start < begin.end) {
			endIdx++;
		}
		if (endIdx >= ends.length) break;

		const end = ends[endIdx];
		endIdx++;

		regions.push({
			condition: begin.condition,
			contentRange: new vscode.Range(
				doc.positionAt(begin.end),
				doc.positionAt(end.start),
			),
			fullRange: new vscode.Range(
				doc.positionAt(begin.start),
				doc.positionAt(end.end),
			),
		});
	}

	return regions;
}

/** Parse a document for all DWT markers and compute regions. */
export function parseDocument(doc: vscode.TextDocument): DwtParseResult {
	const text = doc.getText();
	const fileType = detectFileType(text);

	if (fileType === 'none') {
		return {
			fileType: 'none',
			templateDeclaration: null,
			editableRegions: [],
			protectedRegions: [],
			instanceParams: [],
			templateVariables: [],
			conditionalRegions: [],
		};
	}

	// Parse editable regions with the appropriate marker variant
	const editableRegions = fileType === 'template'
		? parseEditableRegions(doc, text, TEMPLATE_BEGIN_EDITABLE, TEMPLATE_END_EDITABLE)
		: parseEditableRegions(doc, text, INSTANCE_BEGIN_EDITABLE, INSTANCE_END_EDITABLE);

	const protectedRegions = computeProtectedRegions(doc, editableRegions);

	const templateDeclaration = fileType === 'instance'
		? parseTemplateDeclaration(doc, text)
		: null;

	const instanceParams = fileType === 'instance'
		? parseInstanceParams(doc, text)
		: [];

	const templateVariables = parseTemplateVariables(doc, text);
	const conditionalRegions = parseConditionalRegions(doc, text);

	return {
		fileType,
		templateDeclaration,
		editableRegions,
		protectedRegions,
		instanceParams,
		templateVariables,
		conditionalRegions,
	};
}

/** Cache for parse results, keyed by document URI + version. */
export class ParseCache {
	private cache = new Map<string, { version: number; result: DwtParseResult }>();

	/** Get cached result or parse fresh. */
	getOrParse(doc: vscode.TextDocument): DwtParseResult {
		const key = doc.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === doc.version) {
			return cached.result;
		}
		const result = parseDocument(doc);
		this.cache.set(key, { version: doc.version, result });
		return result;
	}

	/** Invalidate cache for a specific document. */
	invalidate(uri: vscode.Uri): void {
		this.cache.delete(uri.toString());
	}

	/** Clear all cached results. */
	clear(): void {
		this.cache.clear();
	}
}
