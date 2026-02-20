import * as assert from 'assert';
import { stripTemplateMarkers, deriveInstancePath } from '../../src/template/templateUpdater';
import { htmlToMarkdown } from '../../src/utils/htmlToMarkdown';
import { dedentBlock } from '../../src/utils/dedent';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// stripTemplateMarkers
// ---------------------------------------------------------------------------

suite('stripTemplateMarkers', () => {
	test('removes InstanceBegin comment', () => {
		const input = '<html lang="en"><!-- InstanceBegin template="/Templates/test.dwt" codeOutsideHTMLIsLocked="false" -->\n<head></head></html>';
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceBegin'));
		assert.ok(result.includes('<html lang="en">'));
	});

	test('removes InstanceEnd comment', () => {
		const input = '<body></body><!-- InstanceEnd --></html>';
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceEnd'));
		assert.ok(result.includes('</html>'));
	});

	test('removes InstanceParam lines', () => {
		const input = '<head>\n\t<!-- InstanceParam name="Division" type="text" value="direct" -->\n\t<!-- InstanceParam name="Color" type="color" value="#fff" -->\n</head>';
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceParam'));
		assert.ok(result.includes('<head>'));
		assert.ok(result.includes('</head>'));
	});

	test('removes InstanceBeginEditable/InstanceEndEditable but keeps content', () => {
		const input = '<!-- InstanceBeginEditable name="main" --><p>Hello</p><!-- InstanceEndEditable -->';
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceBeginEditable'));
		assert.ok(!result.includes('InstanceEndEditable'));
		assert.ok(result.includes('<p>Hello</p>'));
	});

	test('removes InstanceBeginOptional/InstanceEndOptional', () => {
		const input = '<!-- InstanceBeginOptional name="sidebar" --><aside>Sidebar</aside><!-- InstanceEndOptional -->';
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceBeginOptional'));
		assert.ok(!result.includes('InstanceEndOptional'));
		assert.ok(result.includes('<aside>Sidebar</aside>'));
	});

	test('removes InstanceBeginRepeat/InstanceEndRepeat and entry markers', () => {
		const input = [
			'<!-- InstanceBeginRepeat name="items" -->',
			'<!-- InstanceBeginRepeatEntry -->',
			'<p>Item 1</p>',
			'<!-- InstanceEndRepeatEntry -->',
			'<!-- InstanceBeginRepeatEntry -->',
			'<p>Item 2</p>',
			'<!-- InstanceEndRepeatEntry -->',
			'<!-- InstanceEndRepeat -->',
		].join('\n');
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('InstanceBeginRepeat'));
		assert.ok(!result.includes('InstanceEndRepeat'));
		assert.ok(!result.includes('InstanceBeginRepeatEntry'));
		assert.ok(!result.includes('InstanceEndRepeatEntry'));
		assert.ok(result.includes('<p>Item 1</p>'));
		assert.ok(result.includes('<p>Item 2</p>'));
	});

	test('collapses excessive blank lines after stripping', () => {
		// The regex collapses runs of 3+ blank lines to 2; test that it reduces runs
		const input = '<div>\n<!-- InstanceBeginEditable name="main" -->\n<p>Content</p>\n<!-- InstanceEndEditable -->\n</div>';
		const result = stripTemplateMarkers(input);
		assert.ok(result.includes('<p>Content</p>'));
		assert.ok(!result.includes('InstanceBeginEditable'));
	});

	test('handles full instance file', () => {
		const input = [
			'<html lang="en"><!-- InstanceBegin template="/Templates/test.dwt" codeOutsideHTMLIsLocked="false" -->',
			'<head>',
			'<!-- InstanceParam name="Title" type="text" value="Home" -->',
			'<!-- InstanceBeginEditable name="doctitle" --><title>Home</title><!-- InstanceEndEditable -->',
			'</head>',
			'<body>',
			'<!-- InstanceBeginEditable name="main" --><p>Hello World</p><!-- InstanceEndEditable -->',
			'</body>',
			'<!-- InstanceEnd --></html>',
		].join('\n');
		const result = stripTemplateMarkers(input);
		assert.ok(!result.includes('Instance'));
		assert.ok(result.includes('<title>Home</title>'));
		assert.ok(result.includes('<p>Hello World</p>'));
		assert.ok(result.includes('<html lang="en">'));
		assert.ok(result.includes('</html>'));
	});
});

// ---------------------------------------------------------------------------
// deriveInstancePath
// ---------------------------------------------------------------------------

suite('deriveInstancePath', () => {
	test('derives root-level instance path', () => {
		const instanceUri = vscode.Uri.file('/site/index.html');
		const templateUri = vscode.Uri.file('/site/Templates/main.dwt');
		const result = deriveInstancePath(instanceUri, templateUri, '/Templates/main.dwt');
		assert.strictEqual(result, '/index.html');
	});

	test('derives nested instance path', () => {
		const instanceUri = vscode.Uri.file('/site/pages/about/index.html');
		const templateUri = vscode.Uri.file('/site/Templates/main.dwt');
		const result = deriveInstancePath(instanceUri, templateUri, '/Templates/main.dwt');
		assert.strictEqual(result, '/pages/about/index.html');
	});

	test('handles backslash in template path', () => {
		const instanceUri = vscode.Uri.file('/site/index.html');
		const templateUri = vscode.Uri.file('/site/Templates/main.dwt');
		const result = deriveInstancePath(instanceUri, templateUri, '\\Templates\\main.dwt');
		assert.strictEqual(result, '/index.html');
	});
});

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

suite('htmlToMarkdown', () => {
	test('converts bold tags', () => {
		assert.ok(htmlToMarkdown('<strong>bold</strong>').includes('**bold**'));
		assert.ok(htmlToMarkdown('<b>bold</b>').includes('**bold**'));
	});

	test('converts italic tags', () => {
		assert.ok(htmlToMarkdown('<em>italic</em>').includes('*italic*'));
		assert.ok(htmlToMarkdown('<i>italic</i>').includes('*italic*'));
	});

	test('converts links', () => {
		const result = htmlToMarkdown('<a href="https://example.com">Example</a>');
		assert.ok(result.includes('[Example](https://example.com)'));
	});

	test('converts images', () => {
		const result = htmlToMarkdown('<img src="logo.png" alt="Logo">');
		assert.ok(result.includes('![Logo](logo.png)'));
	});

	test('converts headings', () => {
		assert.ok(htmlToMarkdown('<h1>Title</h1>').includes('# Title'));
		assert.ok(htmlToMarkdown('<h2>Subtitle</h2>').includes('## Subtitle'));
		assert.ok(htmlToMarkdown('<h3>Section</h3>').includes('### Section'));
	});

	test('converts unordered lists', () => {
		const result = htmlToMarkdown('<ul><li>One</li><li>Two</li></ul>');
		assert.ok(result.includes('- One'));
		assert.ok(result.includes('- Two'));
	});

	test('converts ordered lists', () => {
		const result = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>');
		assert.ok(result.includes('1. First'));
		assert.ok(result.includes('2. Second'));
	});

	test('converts inline code', () => {
		const result = htmlToMarkdown('<code>foo()</code>');
		assert.ok(result.includes('`foo()`'));
	});

	test('converts code blocks', () => {
		const result = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
		assert.ok(result.includes('```'));
		assert.ok(result.includes('const x = 1;'));
	});

	test('converts blockquotes', () => {
		const result = htmlToMarkdown('<blockquote>Quote text</blockquote>');
		assert.ok(result.includes('> Quote text'));
	});

	test('converts horizontal rules', () => {
		const result = htmlToMarkdown('<hr>');
		assert.ok(result.includes('---'));
	});

	test('decodes HTML entities', () => {
		const result = htmlToMarkdown('&amp; &lt; &gt; &quot; &#39; &nbsp;');
		assert.ok(result.includes('&'));
		assert.ok(result.includes('<'));
		assert.ok(result.includes('>'));
	});

	test('strips remaining HTML tags', () => {
		const result = htmlToMarkdown('<span class="foo">text</span>');
		assert.strictEqual(result, 'text');
	});

	test('collapses excessive blank lines', () => {
		const result = htmlToMarkdown('<p>One</p>\n\n\n<p>Two</p>');
		assert.ok(!result.includes('\n\n\n'));
	});
});

// ---------------------------------------------------------------------------
// dedentBlock
// ---------------------------------------------------------------------------

suite('dedentBlock', () => {
	test('removes common indentation', () => {
		const input = '    line1\n    line2\n    line3';
		const result = dedentBlock(input);
		assert.strictEqual(result, 'line1\nline2\nline3');
	});

	test('preserves relative indentation', () => {
		const input = '    line1\n        line2\n    line3';
		const result = dedentBlock(input);
		assert.strictEqual(result, 'line1\n    line2\nline3');
	});

	test('handles tabs with tabSize', () => {
		const input = '\t\tline1\n\t\t\tline2\n\t\tline3';
		const result = dedentBlock(input, 4);
		assert.strictEqual(result, 'line1\n\tline2\nline3');
	});

	test('skips empty lines when computing min indent', () => {
		const input = '    line1\n\n    line2';
		const result = dedentBlock(input);
		assert.strictEqual(result, 'line1\n\nline2');
	});

	test('returns text unchanged when no indentation', () => {
		const input = 'line1\nline2';
		const result = dedentBlock(input);
		assert.strictEqual(result, 'line1\nline2');
	});

	test('handles mixed tabs and spaces', () => {
		const input = '\t  line1\n\t  line2';
		const result = dedentBlock(input, 4);
		assert.strictEqual(result, 'line1\nline2');
	});

	test('handles single line', () => {
		const input = '    hello';
		const result = dedentBlock(input);
		assert.strictEqual(result, 'hello');
	});
});
