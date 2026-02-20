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
	OptionalRegion,
	LibraryItem,
	RepeatEntry,
	RepeatRegion,
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

// Optional regions (template variant — used in .dwt files)
const TEMPLATE_BEGIN_OPTIONAL = /<!--\s*TemplateBeginOptional\s+name="([^"]+)"\s*-->/g;
const TEMPLATE_END_OPTIONAL = /<!--\s*TemplateEndOptional\s*-->/g;

// Optional regions (instance variant — used in resolved .html pages)
const INSTANCE_BEGIN_OPTIONAL = /<!--\s*InstanceBeginOptional\s+name="([^"]+)"\s*-->/g;
const INSTANCE_END_OPTIONAL = /<!--\s*InstanceEndOptional\s*-->/g;

// Library item markers
const BEGIN_LIBRARY_ITEM = /<!--\s*#BeginLibraryItem\s+"([^"]+)"\s*-->/g;
const END_LIBRARY_ITEM = /<!--\s*#EndLibraryItem\s*-->/g;

// Repeating region markers (template variant)
const TEMPLATE_BEGIN_REPEAT = /<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->/g;
const TEMPLATE_END_REPEAT = /<!--\s*TemplateEndRepeat\s*-->/g;

// Repeating region markers (instance variant)
const INSTANCE_BEGIN_REPEAT = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->/g;
const INSTANCE_END_REPEAT = /<!--\s*InstanceEndRepeat\s*-->/g;
const INSTANCE_BEGIN_REPEAT_ENTRY = /<!--\s*InstanceBeginRepeatEntry\s*-->/g;
const INSTANCE_END_REPEAT_ENTRY = /<!--\s*InstanceEndRepeatEntry\s*-->/g;

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

/**
 * Parse optional region markers.
 * In .dwt template files: TemplateBeginOptional/TemplateEndOptional
 * In resolved instance files: InstanceBeginOptional/InstanceEndOptional
 */
function parseOptionalRegions(
	doc: vscode.TextDocument,
	text: string,
	fileType: DwtFileType,
): OptionalRegion[] {
	const beginRe = fileType === 'instance' ? INSTANCE_BEGIN_OPTIONAL : TEMPLATE_BEGIN_OPTIONAL;
	const endRe = fileType === 'instance' ? INSTANCE_END_OPTIONAL : TEMPLATE_END_OPTIONAL;

	const begins: { name: string; start: number; end: number }[] = [];
	beginRe.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = beginRe.exec(text)) !== null) {
		begins.push({
			name: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	const ends = findEndMarkers(endRe, text);
	const regions: OptionalRegion[] = [];
	let endIdx = 0;

	for (const begin of begins) {
		while (endIdx < ends.length && ends[endIdx].start < begin.end) {
			endIdx++;
		}
		if (endIdx >= ends.length) break;

		const end = ends[endIdx];
		endIdx++;

		regions.push({
			name: begin.name,
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

/**
 * Parse repeating regions.
 * In .dwt template files: TemplateBeginRepeat/TemplateEndRepeat (no entries yet).
 * In resolved instance files: InstanceBeginRepeat/InstanceEndRepeat containing
 * InstanceBeginRepeatEntry/InstanceEndRepeatEntry blocks.
 */
function parseRepeatRegions(
	doc: vscode.TextDocument,
	text: string,
	fileType: DwtFileType,
): RepeatRegion[] {
	if (fileType === 'template') {
		// Templates just define repeat regions — no entries yet
		const begins: { name: string; start: number; end: number }[] = [];
		TEMPLATE_BEGIN_REPEAT.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = TEMPLATE_BEGIN_REPEAT.exec(text)) !== null) {
			begins.push({ name: m[1], start: m.index, end: m.index + m[0].length });
		}
		const ends = findEndMarkers(TEMPLATE_END_REPEAT, text);
		const regions: RepeatRegion[] = [];
		let endIdx = 0;
		for (const begin of begins) {
			while (endIdx < ends.length && ends[endIdx].start <= begin.end) endIdx++;
			if (endIdx >= ends.length) break;
			const end = ends[endIdx++];
			regions.push({
				name: begin.name,
				entries: [],
				beginMarkerRange: new vscode.Range(doc.positionAt(begin.start), doc.positionAt(begin.end)),
				endMarkerRange: new vscode.Range(doc.positionAt(end.start), doc.positionAt(end.end)),
				fullRange: new vscode.Range(doc.positionAt(begin.start), doc.positionAt(end.end)),
			});
		}
		return regions;
	}

	// Instance file: parse InstanceBeginRepeat blocks with nested entries
	const outerBegins: { name: string; start: number; end: number }[] = [];
	INSTANCE_BEGIN_REPEAT.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = INSTANCE_BEGIN_REPEAT.exec(text)) !== null) {
		outerBegins.push({ name: m[1], start: m.index, end: m.index + m[0].length });
	}

	const outerEnds = findEndMarkers(INSTANCE_END_REPEAT, text);
	const regions: RepeatRegion[] = [];
	let outerEndIdx = 0;

	for (const ob of outerBegins) {
		while (outerEndIdx < outerEnds.length && outerEnds[outerEndIdx].start <= ob.end) outerEndIdx++;
		if (outerEndIdx >= outerEnds.length) break;
		const oe = outerEnds[outerEndIdx++];

		// Extract text slice for this repeat region to find entries
		const regionText = text.slice(ob.end, oe.start);
		const regionOffset = ob.end;

		// Find InstanceBeginRepeatEntry/InstanceEndRepeatEntry within
		const entryBegins: { start: number; end: number }[] = [];
		const entryEnds: { start: number; end: number }[] = [];
		INSTANCE_BEGIN_REPEAT_ENTRY.lastIndex = 0;
		let em: RegExpExecArray | null;
		while ((em = INSTANCE_BEGIN_REPEAT_ENTRY.exec(regionText)) !== null) {
			entryBegins.push({ start: regionOffset + em.index, end: regionOffset + em.index + em[0].length });
		}
		INSTANCE_END_REPEAT_ENTRY.lastIndex = 0;
		while ((em = INSTANCE_END_REPEAT_ENTRY.exec(regionText)) !== null) {
			entryEnds.push({ start: regionOffset + em.index, end: regionOffset + em.index + em[0].length });
		}

		const entries: RepeatEntry[] = [];
		let entryEndIdx = 0;
		for (const eb of entryBegins) {
			while (entryEndIdx < entryEnds.length && entryEnds[entryEndIdx].start <= eb.end) entryEndIdx++;
			if (entryEndIdx >= entryEnds.length) break;
			const ee = entryEnds[entryEndIdx++];

			// Parse editable regions within this entry
			const entryContent = text.slice(eb.end, ee.start);
			// Re-use findBeginMarkers/findEndMarkers on the slice; convert offsets back
			const ebOffset = eb.end;
			const beginMatches = findBeginMarkers(INSTANCE_BEGIN_EDITABLE, entryContent);
			const endMatches = findEndMarkers(INSTANCE_END_EDITABLE, entryContent);
			const entryEditables: EditableRegion[] = [];
			let eidx = 0;
			for (const bm of beginMatches) {
				while (eidx < endMatches.length && endMatches[eidx].start < bm.end) eidx++;
				if (eidx >= endMatches.length) break;
				const em2 = endMatches[eidx++];
				entryEditables.push({
					name: bm.name,
					beginMarkerRange: new vscode.Range(doc.positionAt(ebOffset + bm.start), doc.positionAt(ebOffset + bm.end)),
					endMarkerRange: new vscode.Range(doc.positionAt(ebOffset + em2.start), doc.positionAt(ebOffset + em2.end)),
					contentRange: new vscode.Range(doc.positionAt(ebOffset + bm.end), doc.positionAt(ebOffset + em2.start)),
					fullRange: new vscode.Range(doc.positionAt(ebOffset + bm.start), doc.positionAt(ebOffset + em2.end)),
				});
			}

			entries.push({
				editableRegions: entryEditables,
				contentRange: new vscode.Range(doc.positionAt(eb.end), doc.positionAt(ee.start)),
				fullRange: new vscode.Range(doc.positionAt(eb.start), doc.positionAt(ee.end)),
			});
		}

		regions.push({
			name: ob.name,
			entries,
			beginMarkerRange: new vscode.Range(doc.positionAt(ob.start), doc.positionAt(ob.end)),
			endMarkerRange: new vscode.Range(doc.positionAt(oe.start), doc.positionAt(oe.end)),
			fullRange: new vscode.Range(doc.positionAt(ob.start), doc.positionAt(oe.end)),
		});
	}

	return regions;
}

/** Parse #BeginLibraryItem / #EndLibraryItem library item regions. */
function parseLibraryItems(doc: vscode.TextDocument, text: string): LibraryItem[] {
	const begins: { path: string; start: number; end: number }[] = [];
	BEGIN_LIBRARY_ITEM.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = BEGIN_LIBRARY_ITEM.exec(text)) !== null) {
		begins.push({
			path: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	const ends = findEndMarkers(END_LIBRARY_ITEM, text);
	const items: LibraryItem[] = [];
	let endIdx = 0;

	for (const begin of begins) {
		while (endIdx < ends.length && ends[endIdx].start <= begin.end) {
			endIdx++;
		}
		if (endIdx >= ends.length) break;

		const end = ends[endIdx];
		endIdx++;

		items.push({
			path: begin.path,
			beginMarkerRange: new vscode.Range(
				doc.positionAt(begin.start),
				doc.positionAt(begin.end),
			),
			endMarkerRange: new vscode.Range(
				doc.positionAt(end.start),
				doc.positionAt(end.end),
			),
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

	return items;
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
			optionalRegions: [],
			libraryItems: [],
			repeatRegions: [],
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
	const optionalRegions = parseOptionalRegions(doc, text, fileType);
	const libraryItems = parseLibraryItems(doc, text);
	const repeatRegions = parseRepeatRegions(doc, text, fileType);

	// Library item regions are locked — add them to protectedRegions
	// (the content between #BeginLibraryItem and #EndLibraryItem is non-editable)
	for (const item of libraryItems) {
		protectedRegions.push({ range: item.contentRange });
	}

	return {
		fileType,
		templateDeclaration,
		editableRegions,
		protectedRegions,
		instanceParams,
		templateVariables,
		conditionalRegions,
		optionalRegions,
		libraryItems,
		repeatRegions,
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
