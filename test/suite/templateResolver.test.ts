import * as assert from 'assert';
import { resolveTemplate, evaluateCondition } from '../../src/template/templateResolver';

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

suite('evaluateCondition', () => {
	const params = new Map([
		['Division', 'direct'],
		['ID', 'newsletter'],
		['Staff', 'true'],
		['Show Full Width Promo', 'false'],
	]);

	test('string equality — true', () => {
		assert.strictEqual(evaluateCondition("Division=='direct'", params), true);
	});

	test('string equality — false', () => {
		assert.strictEqual(evaluateCondition("Division=='broker-services'", params), false);
	});

	test('string inequality — true', () => {
		assert.strictEqual(evaluateCondition("Division!='broker-services'", params), true);
	});

	test('string inequality — false', () => {
		assert.strictEqual(evaluateCondition("Division!='direct'", params), false);
	});

	test('bracket syntax boolean truthiness — true', () => {
		assert.strictEqual(evaluateCondition("_document['Staff']", params), true);
	});

	test('bracket syntax boolean truthiness — false', () => {
		assert.strictEqual(evaluateCondition("_document['Show Full Width Promo']", params), false);
	});

	test('bracket syntax string equality', () => {
		assert.strictEqual(
			evaluateCondition("_document['Division']=='direct'", params),
			true,
		);
	});

	test('unrecognized condition defaults to true', () => {
		assert.strictEqual(evaluateCondition('some && complex || expr', params), true);
	});
});

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

suite('resolveTemplate', () => {
	test('substitutes @@(ParamName)@@ variables', () => {
		const result = resolveTemplate({
			templateText: '<body class="@@(Division)@@" data-id="@@(ID)@@"></body></html>',
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Division', 'direct'], ['ID', 'home']]),
			paramTypes: new Map([['Division', 'text'], ['ID', 'text']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('class="direct"'));
		assert.ok(result.includes('data-id="home"'));
	});

	test('substitutes @@(_document[\'Param Name\'])@@ bracket variables', () => {
		const result = resolveTemplate({
			templateText: '<div style="color: @@(_document[\'BG Color\'])@@"></div></html>',
			templatePath: '/Templates/Test.dwt',
			params: new Map([['BG Color', '#ff0000']]),
			paramTypes: new Map([['BG Color', 'color']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('color: #ff0000'));
	});

	test('true conditional keeps content', () => {
		const template = [
			'<div>',
			'<!-- TemplateBeginIf cond="Division==\'direct\'" -->',
			'<p>Direct content</p>',
			'<!-- TemplateEndIf -->',
			'</div></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Division', 'direct']]),
			paramTypes: new Map([['Division', 'text']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<p>Direct content</p>'));
		assert.ok(!result.includes('TemplateBeginIf'));
		assert.ok(!result.includes('TemplateEndIf'));
	});

	test('false conditional removes content', () => {
		const template = [
			'<div>',
			'<!-- TemplateBeginIf cond="Division==\'broker\'" -->',
			'<p>Broker content</p>',
			'<!-- TemplateEndIf -->',
			'</div></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Division', 'direct']]),
			paramTypes: new Map([['Division', 'text']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(!result.includes('<p>Broker content</p>'));
		assert.ok(!result.includes('TemplateBeginIf'));
	});

	test('boolean param toggles conditional', () => {
		const template = [
			'<!-- TemplateBeginIf cond="_document[\'Staff\']" -->',
			'<script src="staff.js"></script>',
			'<!-- TemplateEndIf -->',
			'</html>',
		].join('');

		// Staff=true → content kept
		const resultTrue = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Staff', 'true']]),
			paramTypes: new Map([['Staff', 'boolean']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(resultTrue.includes('<script src="staff.js"></script>'));

		// Staff=false → content removed
		const resultFalse = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Staff', 'false']]),
			paramTypes: new Map([['Staff', 'boolean']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(!resultFalse.includes('<script src="staff.js"></script>'));
	});

	test('preserves editable region content from instance', () => {
		const template = [
			'<html><head>',
			'<!-- TemplateBeginEditable name="doctitle" -->',
			'<title>Default</title>',
			'<!-- TemplateEndEditable -->',
			'</head></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map(),
			paramTypes: new Map(),
			editableContents: new Map([['doctitle', '\n<title>My Custom Title</title>\n']]),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<title>My Custom Title</title>'));
		assert.ok(!result.includes('<title>Default</title>'));
		assert.ok(result.includes('InstanceBeginEditable name="doctitle"'));
		assert.ok(result.includes('InstanceEndEditable'));
		assert.ok(!result.includes('TemplateBeginEditable'));
	});

	test('uses template default content for missing editable region', () => {
		const template = [
			'<html><head>',
			'<!-- TemplateBeginEditable name="doctitle" -->',
			'<title>Default Title</title>',
			'<!-- TemplateEndEditable -->',
			'</head></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map(),
			paramTypes: new Map(),
			editableContents: new Map(), // no content for "doctitle"
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<title>Default Title</title>'));
	});

	test('TemplateParam defaults used when no instance override', () => {
		const template = [
			'<!-- TemplateParam name="Color" type="text" value="red" -->',
			'<div class="@@(Color)@@"></div></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map(), // no override
			paramTypes: new Map(),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('class="red"'));
		assert.ok(!result.includes('TemplateParam'));
	});

	test('instance param overrides TemplateParam default', () => {
		const template = [
			'<!-- TemplateParam name="Color" type="text" value="red" -->',
			'<div class="@@(Color)@@"></div></html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Color', 'blue']]),
			paramTypes: new Map([['Color', 'text']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('class="blue"'));
	});

	test('inserts InstanceBegin after <html> tag', () => {
		const template = '<html lang="en">\n<head></head></html>';

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Main.dwt',
			params: new Map(),
			paramTypes: new Map(),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(
			result.includes('<html lang="en"><!-- InstanceBegin template="/Templates/Main.dwt"'),
		);
	});

	test('inserts InstanceEnd before </html>', () => {
		const template = '<html>\n<body></body>\n</html>';

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Main.dwt',
			params: new Map(),
			paramTypes: new Map(),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<!-- InstanceEnd --></html>'));
	});

	test('inserts InstanceParam tags before </head>', () => {
		const template = '<html>\n<head>\n</head></html>';

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['Division', 'direct']]),
			paramTypes: new Map([['Division', 'text']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<!-- InstanceParam name="Division" type="text" value="direct" -->'));
	});

	test('editable region inside false conditional is removed', () => {
		const template = [
			'<!-- TemplateBeginIf cond="_document[\'ShowPromo\']" -->',
			'<!-- TemplateBeginEditable name="promo" -->',
			'<p>Default promo</p>',
			'<!-- TemplateEndEditable -->',
			'<!-- TemplateEndIf -->',
			'</html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['ShowPromo', 'false']]),
			paramTypes: new Map([['ShowPromo', 'boolean']]),
			editableContents: new Map(),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(!result.includes('promo'));
		assert.ok(!result.includes('Default promo'));
	});

	test('editable region inside true conditional is preserved', () => {
		const template = [
			'<!-- TemplateBeginIf cond="_document[\'ShowPromo\']" -->',
			'<!-- TemplateBeginEditable name="promo" -->',
			'<p>Default promo</p>',
			'<!-- TemplateEndEditable -->',
			'<!-- TemplateEndIf -->',
			'</html>',
		].join('\n');

		const result = resolveTemplate({
			templateText: template,
			templatePath: '/Templates/Test.dwt',
			params: new Map([['ShowPromo', 'true']]),
			paramTypes: new Map([['ShowPromo', 'boolean']]),
			editableContents: new Map([['promo', '<p>Custom promo</p>']]),
			codeOutsideHTMLIsLocked: false,
		});
		assert.ok(result.includes('<p>Custom promo</p>'));
		assert.ok(result.includes('InstanceBeginEditable name="promo"'));
	});
});
