/**
 * Pure-function template resolver — takes a .dwt template string and
 * produces a resolved instance page string.  No VS Code APIs.
 */

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

	// Insert InstanceParam lines before </head>
	text = text.replace('</head>', `${paramLines}\n</head>`);

	// Insert InstanceEnd before </html>
	text = text.replace(/<\/html>\s*$/, '<!-- InstanceEnd --></html>\n');

	return text;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function resolveTemplate(options: ResolveOptions): string {
	let text = options.templateText;

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

	// 4. Replace @@(...)@@ variables
	text = resolveVariables(text, mergedParams);

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
