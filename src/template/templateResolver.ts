/**
 * Pure-function template resolver — takes a .dwt template string and
 * produces a resolved instance page string.  No VS Code APIs.
 */

import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveOptions {
	/** Raw text of the .dwt template file */
	templateText: string;
	/** Site-relative template path, e.g. "/Templates/Division Page.dwt" */
	templatePath: string;
	/** Instance param values (name → value).  Overrides TemplateParam defaults. */
	params: Map<string, string>;
	/** Instance param types (name → type like "text"|"boolean"|"color"). */
	paramTypes: Map<string, string>;
	/** Editable region contents extracted from the current instance page. */
	editableContents: Map<string, string>;
	/** Value of codeOutsideHTMLIsLocked from the InstanceBegin tag */
	codeOutsideHTMLIsLocked: boolean;
	/** Site-relative instance-page path, e.g. "/index.html".
	 *  When provided, relative URLs in template regions are rewritten so
	 *  they resolve correctly from the instance page's directory. */
	instancePath?: string;
	/**
	 * Repeat region entries from the existing instance.
	 * key = region name; value = array of entry objects (editableRegionName → content).
	 */
	repeatEntries?: Map<string, Map<string, string>[]>;
}

interface TemplateParamDef {
	name: string;
	type: string;
	value: string;
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

const TEMPLATE_PARAM_RE =
	/<!--\s*TemplateParam\s+name="([^"]+)"\s+type="([^"]+)"\s+value="([^"]*?)"\s*-->/g;

const TEMPLATE_BEGIN_IF_RE =
	/<!--\s*TemplateBeginIf\s+cond="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndIf\s*-->/g;

const TEMPLATE_VARIABLE_RE = /@@\(([^)]+)\)@@/g;

const TEMPLATE_EDITABLE_RE =
	/<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;

const TEMPLATE_OPTIONAL_RE =
	/<!--\s*TemplateBeginOptional\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndOptional\s*-->/g;

const TEMPLATE_REPEAT_RE =
	/<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndRepeat\s*-->/g;

/** Matches InstanceBeginEditable in a nested .dwt (child template). */
const INSTANCE_EDITABLE_RE =
	/<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/g;

/** Detects whether a template is itself a nested instance (child template). */
const INSTANCE_BEGIN_RE = /<!--\s*InstanceBegin\s+template="([^"]+)"/;

// ---------------------------------------------------------------------------
// TemplateParam parsing
// ---------------------------------------------------------------------------

function parseTemplateParams(text: string): TemplateParamDef[] {
	const results: TemplateParamDef[] = [];
	TEMPLATE_PARAM_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TEMPLATE_PARAM_RE.exec(text)) !== null) {
		results.push({ name: m[1], type: m[2], value: m[3] });
	}
	return results;
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a Dreamweaver template condition string against a param map.
 *
 * Supported forms:
 *   ParamName=='value'          string equality
 *   ParamName!='value'          string inequality
 *   _document['Param Name']     boolean truthiness (value === "true")
 *   _document['Param Name']=='value'   string equality (bracket syntax)
 */
export function evaluateCondition(
	condition: string,
	params: Map<string, string>,
): boolean {
	const trimmed = condition.trim();

	// String equality / inequality:  ParamName=='value'  or  _document['X']=='value'
	const eqMatch = trimmed.match(
		/^(?:_document\['([^']+)'\]|(\w+))\s*(==|!=)\s*'([^']*)'/,
	);
	if (eqMatch) {
		const paramName = eqMatch[1] ?? eqMatch[2];
		const op = eqMatch[3];
		const compareValue = eqMatch[4];
		const actual = params.get(paramName) ?? '';
		return op === '==' ? actual === compareValue : actual !== compareValue;
	}

	// Also handle double-quoted comparisons
	const eqMatchDbl = trimmed.match(
		/^(?:_document\['([^']+)'\]|(\w+))\s*(==|!=)\s*"([^"]*)"/,
	);
	if (eqMatchDbl) {
		const paramName = eqMatchDbl[1] ?? eqMatchDbl[2];
		const op = eqMatchDbl[3];
		const compareValue = eqMatchDbl[4];
		const actual = params.get(paramName) ?? '';
		return op === '==' ? actual === compareValue : actual !== compareValue;
	}

	// Boolean truthiness:  _document['Param Name']
	const boolMatch = trimmed.match(/^_document\['([^']+)'\]$/);
	if (boolMatch) {
		const val = params.get(boolMatch[1]) ?? '';
		return val === 'true';
	}

	// Bare identifier truthiness:  ParamName  (less common but possible)
	const bareMatch = trimmed.match(/^(\w+)$/);
	if (bareMatch) {
		const val = params.get(bareMatch[1]) ?? '';
		return val === 'true';
	}

	// Unrecognized condition — default to true (keep content)
	return true;
}

// ---------------------------------------------------------------------------
// Optional region resolution
// ---------------------------------------------------------------------------

/**
 * Process TemplateBeginOptional/TemplateEndOptional blocks.
 * If the corresponding boolean param is true (default when absent), keep the content
 * wrapped in InstanceBeginOptional/InstanceEndOptional markers.
 * If false, remove the entire block.
 */
function resolveOptionalRegions(
	text: string,
	params: Map<string, string>,
): string {
	TEMPLATE_OPTIONAL_RE.lastIndex = 0;
	return text.replace(
		TEMPLATE_OPTIONAL_RE,
		(_match, name: string, content: string) => {
			const val = params.get(name);
			const isVisible = val === undefined ? true : val === 'true';
			if (!isVisible) return '';
			return `<!-- InstanceBeginOptional name="${name}" -->${content}<!-- InstanceEndOptional -->`;
		},
	);
}

// ---------------------------------------------------------------------------
// Repeat region resolution
// ---------------------------------------------------------------------------

/**
 * Process TemplateBeginRepeat/TemplateEndRepeat blocks.
 *
 * If `repeatEntries` is provided for this region, generate one
 * InstanceBeginRepeatEntry/InstanceEndRepeatEntry block per entry,
 * substituting each entry's editable contents into the template block.
 *
 * If no entries are provided (e.g., new file), generate one default entry
 * using the template's default editable region content.
 */
function resolveRepeatRegions(
	text: string,
	repeatEntries: Map<string, Map<string, string>[]>,
): string {
	TEMPLATE_REPEAT_RE.lastIndex = 0;
	return text.replace(
		TEMPLATE_REPEAT_RE,
		(_match, name: string, templateBlock: string) => {
			const entries = repeatEntries.get(name);
			const entryList = entries && entries.length > 0 ? entries : [new Map<string, string>()];

			const entryBlocks = entryList.map((entryContents) => {
				// Substitute this entry's editable contents into the template block
				const resolved = resolveEditableRegions(templateBlock, entryContents);
				return `<!-- InstanceBeginRepeatEntry -->${resolved}<!-- InstanceEndRepeatEntry -->`;
			});

			return (
				`<!-- InstanceBeginRepeat name="${name}" -->` +
				entryBlocks.join('') +
				`<!-- InstanceEndRepeat -->`
			);
		},
	);
}

// ---------------------------------------------------------------------------
// Conditional resolution
// ---------------------------------------------------------------------------

function resolveConditionals(
	text: string,
	params: Map<string, string>,
): string {
	// Iterate until stable to handle nested conditionals
	let prev = '';
	while (prev !== text) {
		prev = text;
		TEMPLATE_BEGIN_IF_RE.lastIndex = 0;
		text = text.replace(
			TEMPLATE_BEGIN_IF_RE,
			(_match, condition: string, content: string) => {
				return evaluateCondition(condition, params) ? content : '';
			},
		);
	}
	return text;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

function resolveVariables(
	text: string,
	params: Map<string, string>,
): string {
	TEMPLATE_VARIABLE_RE.lastIndex = 0;
	return text.replace(TEMPLATE_VARIABLE_RE, (_match, expr: string) => {
		const trimmed = expr.trim();

		// _document['Param Name'] form
		const bracketMatch = trimmed.match(/^_document\['([^']+)'\]$/);
		if (bracketMatch) {
			return params.get(bracketMatch[1]) ?? '';
		}

		// Simple identifier: ParamName
		return params.get(trimmed) ?? '';
	});
}

// ---------------------------------------------------------------------------
// Editable region resolution
// ---------------------------------------------------------------------------

function resolveEditableRegions(
	text: string,
	editableContents: Map<string, string>,
): string {
	TEMPLATE_EDITABLE_RE.lastIndex = 0;
	return text.replace(
		TEMPLATE_EDITABLE_RE,
		(_match, name: string, defaultContent: string) => {
			const content = editableContents.has(name)
				? editableContents.get(name)!
				: defaultContent;
			return `<!-- InstanceBeginEditable name="${name}" -->${content}<!-- InstanceEndEditable -->`;
		},
	);
}

// ---------------------------------------------------------------------------
// Nested template instance param sync
// ---------------------------------------------------------------------------

/**
 * Update InstanceParam values in a nested template's text to reflect the
 * current param map (e.g. after the user changes a param value).
 * Lines not present in `params` are left unchanged.
 */
function syncInstanceParams(
	text: string,
	params: Map<string, string>,
	paramTypes: Map<string, string>,
): string {
	// Replace existing InstanceParam lines with updated values
	text = text.replace(
		/<!--\s*InstanceParam\s+name="([^"]+)"\s+type="([^"]+)"\s+value="([^"]*?)"\s*-->/g,
		(_match, name: string, type: string) => {
			const value = params.has(name) ? params.get(name)! : '';
			const resolvedType = paramTypes.get(name) || type;
			return `<!-- InstanceParam name="${name}" type="${resolvedType}" value="${value}" -->`;
		},
	);
	return text;
}

// ---------------------------------------------------------------------------
// Nested template editable region passthrough
// ---------------------------------------------------------------------------

/**
 * For nested templates (a .dwt that is itself an instance of another template),
 * the template text contains InstanceBeginEditable/InstanceEndEditable markers
 * instead of TemplateBeginEditable/TemplateEndEditable.
 *
 * This function substitutes the instance page's editable contents into those
 * markers, leaving the InstanceBeginEditable/InstanceEndEditable wrapper intact
 * so the output is still a valid instance page.
 */
function resolveNestedEditableRegions(
	text: string,
	editableContents: Map<string, string>,
): string {
	INSTANCE_EDITABLE_RE.lastIndex = 0;
	return text.replace(
		INSTANCE_EDITABLE_RE,
		(_match, name: string, defaultContent: string) => {
			const content = editableContents.has(name)
				? editableContents.get(name)!
				: defaultContent;
			return `<!-- InstanceBeginEditable name="${name}" -->${content}<!-- InstanceEndEditable -->`;
		},
	);
}

// ---------------------------------------------------------------------------
// Instance marker insertion
// ---------------------------------------------------------------------------

function insertInstanceMarkers(
	text: string,
	templatePath: string,
	codeOutsideHTMLIsLocked: boolean,
	params: Map<string, string>,
	paramTypes: Map<string, string>,
): string {
	// Insert InstanceBegin after <html...>
	const lockedStr = codeOutsideHTMLIsLocked ? 'true' : 'false';
	text = text.replace(
		/(<html[^>]*>)/i,
		`$1<!-- InstanceBegin template="${templatePath}" codeOutsideHTMLIsLocked="${lockedStr}" -->`,
	);

	// Build InstanceParam block — maintain the order from the params map
	const paramLines = Array.from(params.entries())
		.map(([name, value]) => {
			const type = paramTypes.get(name) || 'text';
			return `\t<!-- InstanceParam name="${name}" type="${type}" value="${value}" -->`;
		})
		.join('\n');

	// Insert InstanceParam lines before </head> (case-insensitive)
	text = text.replace(/<\/head>/i, `${paramLines}\n</head>`);

	// Insert InstanceEnd before </html>
	text = text.replace(/<\/html>\s*$/, '<!-- InstanceEnd --></html>\n');

	return text;
}

// ---------------------------------------------------------------------------
// Relative path rewriting
// ---------------------------------------------------------------------------

/**
 * Regex matching HTML attributes that contain URLs.
 * Captures: (1) attr + opening quote  (2) quote char  (3) URL value
 */
const ATTR_URL_RE =
	/((?:href|src|action|poster|data|background)\s*=\s*)(["'])([^"']*?)\2/gi;

/**
 * Rewrite relative URLs in template markup so they resolve correctly from
 * the instance page's directory rather than the template's directory.
 *
 * Absolute URLs, site-root-relative URLs (`/…`), fragment-only (`#…`),
 * query-only (`?…`), protocol URLs (`http:`, `mailto:`, `tel:`, etc.),
 * and template variable placeholders (`@@(…)@@`) are left untouched.
 */
export function rewriteRelativePaths(
	text: string,
	templatePath: string,
	instancePath: string,
): string {
	const templateDir = path.posix.dirname(templatePath);
	const instanceDir = path.posix.dirname(instancePath);

	if (templateDir === instanceDir) return text;

	ATTR_URL_RE.lastIndex = 0;
	return text.replace(ATTR_URL_RE, (match, attr: string, quote: string, url: string) => {
		// Skip URLs that don't need rewriting
		if (
			!url ||
			url.startsWith('#') ||
			url.startsWith('?') ||
			url.startsWith('/') ||
			/^[a-z][a-z0-9+.-]*:/i.test(url) ||
			url.includes('@@(')
		) {
			return match;
		}

		// Separate the path portion from any query string / fragment
		const splitMatch = url.match(/^([^?#]*)(.*)/);
		if (!splitMatch || !splitMatch[1]) return match;
		const urlPath = splitMatch[1];
		const urlSuffix = splitMatch[2] || '';

		// Resolve the URL against the template's directory to get a
		// site-absolute path, then make it relative to the instance dir.
		const absolute = path.posix.resolve(templateDir, urlPath);
		const rewritten = path.posix.relative(instanceDir, absolute);

		return attr + quote + rewritten + urlSuffix + quote;
	});
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function resolveTemplate(options: ResolveOptions): string {
	let text = options.templateText;

	// Nested template detection: if the .dwt is itself an instance of another
	// template, its locked regions are immutable and its editable regions are
	// marked with InstanceBeginEditable (not TemplateBeginEditable).
	// In this case we skip the normal template processing pipeline and just
	// substitute the page's editable contents into the nested editable markers.
	if (INSTANCE_BEGIN_RE.test(text)) {
		// Rewrite relative paths if needed
		if (options.instancePath) {
			text = rewriteRelativePaths(text, options.templatePath, options.instancePath);
		}
		// Substitute the page's editable contents (or keep existing content)
		text = resolveNestedEditableRegions(text, options.editableContents);
		// Update the InstanceBegin marker to reflect the outermost template path
		// (already present in text — just ensure InstanceParam lines are synced)
		text = syncInstanceParams(text, options.params, options.paramTypes);
		return text;
	}

	// 1. Parse TemplateParam defaults and merge with instance params
	const templateParamDefs = parseTemplateParams(text);
	const mergedParams = new Map<string, string>();
	const mergedTypes = new Map<string, string>();

	// Start with template defaults
	for (const def of templateParamDefs) {
		mergedParams.set(def.name, def.value);
		mergedTypes.set(def.name, def.type);
	}

	// Overlay instance param values and types
	for (const [name, value] of options.params) {
		mergedParams.set(name, value);
	}
	for (const [name, type] of options.paramTypes) {
		mergedTypes.set(name, type);
	}

	// 2. Remove TemplateParam lines
	text = text.replace(
		/[ \t]*<!--\s*TemplateParam\s+name="[^"]+"\s+type="[^"]+"\s+value="[^"]*?"\s*-->\n?/g,
		'',
	);

	// 3. Evaluate conditionals
	text = resolveConditionals(text, mergedParams);

	// 3.5. Show/hide optional regions
	text = resolveOptionalRegions(text, mergedParams);

	// 4. Replace @@(...)@@ variables
	text = resolveVariables(text, mergedParams);

	// 4.5. Rewrite relative paths for the instance page's location
	if (options.instancePath) {
		text = rewriteRelativePaths(text, options.templatePath, options.instancePath);
	}

	// 4.7. Resolve repeating regions
	text = resolveRepeatRegions(text, options.repeatEntries ?? new Map());

	// 5. Replace editable regions
	text = resolveEditableRegions(text, options.editableContents);

	// 6. Insert instance markers
	text = insertInstanceMarkers(
		text,
		options.templatePath,
		options.codeOutsideHTMLIsLocked,
		mergedParams,
		mergedTypes,
	);

	return text;
}
