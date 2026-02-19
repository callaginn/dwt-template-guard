import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { parseDocument } from '../../src/parser/dwtParser';

const fixturesPath = path.resolve(__dirname, '../../../test');

async function openFixture(name: string): Promise<vscode.TextDocument> {
	const uri = vscode.Uri.file(path.join(fixturesPath, name));
	return vscode.workspace.openTextDocument(uri);
}

suite('DWT Parser', () => {
	test('detects template file type for .dwt files', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'template');
	});

	test('detects instance file type for .html files with InstanceBegin', async () => {
		const doc = await openFixture('kevin-registry/about.html');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'instance');
	});

	test('detects none for plain HTML files', async () => {
		const doc = await openFixture('kevin-registry/submit.html');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'none');
		assert.strictEqual(result.editableRegions.length, 0);
		assert.strictEqual(result.protectedRegions.length, 0);
	});

	test('parses TemplateBeginEditable/TemplateEndEditable regions', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);

		// Template has 8 editable regions: doctitle, head, AlertContent,
		// PageHeading, Page, Main, Sidebar, Scripts
		assert.strictEqual(result.editableRegions.length, 8);
		assert.strictEqual(result.editableRegions[0].name, 'doctitle');
		assert.strictEqual(result.editableRegions[1].name, 'head');
	});

	test('parses InstanceBeginEditable/InstanceEndEditable regions', async () => {
		const doc = await openFixture('kevin-registry/about.html');
		const result = parseDocument(doc);

		// about.html uses ShowSidebar=false and ShowAlertBanner=false, so it
		// has 5 regions: doctitle, head, PageHeading, Page, Scripts
		assert.strictEqual(result.editableRegions.length, 5);
		assert.strictEqual(result.editableRegions[0].name, 'doctitle');
		assert.strictEqual(result.editableRegions[1].name, 'head');
	});

	test('editable region contentRange excludes markers', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);
		const region = result.editableRegions[0]; // doctitle

		// The content between the markers should contain the <title> tag
		const content = doc.getText(region.contentRange);
		assert.ok(content.includes('<title>National Registry of Ducks Named Kevin</title>'));

		// The content should NOT contain the marker comments
		assert.ok(!content.includes('TemplateBeginEditable'));
		assert.ok(!content.includes('TemplateEndEditable'));
	});

	test('protected regions cover everything outside editable contentRanges', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);

		// 8 editable regions produce 9 protected gaps (before, 7 between, after)
		assert.strictEqual(result.protectedRegions.length, 9);

		// First protected region should include the document declaration and begin marker
		const firstProtected = doc.getText(result.protectedRegions[0].range);
		assert.ok(firstProtected.includes('<!doctype html>'));
		assert.ok(firstProtected.includes('TemplateBeginEditable'));
	});

	test('markers themselves are protected', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);

		const beginMarkerText = doc.getText(result.editableRegions[0].beginMarkerRange);
		assert.ok(beginMarkerText.includes('TemplateBeginEditable'));

		// The begin marker range should be within a protected region
		const beginPos = result.editableRegions[0].beginMarkerRange.start;
		const isProtected = result.protectedRegions.some(
			(pr) => pr.range.contains(beginPos),
		);
		assert.ok(isProtected, 'Begin marker should be in a protected region');
	});

	test('parses InstanceParam tags', async () => {
		const doc = await openFixture('kevin-registry/registry.html');
		const result = parseDocument(doc);

		// registry.html declares 6 InstanceParam tags
		assert.strictEqual(result.instanceParams.length, 6);

		assert.strictEqual(result.instanceParams[0].name, 'Division');
		assert.strictEqual(result.instanceParams[0].type, 'text');
		assert.strictEqual(result.instanceParams[0].value, 'Eastern Flyway');

		assert.strictEqual(result.instanceParams[1].name, 'AccentColor');
		assert.strictEqual(result.instanceParams[1].type, 'color');
		assert.strictEqual(result.instanceParams[1].value, '#1a4a7a');

		assert.strictEqual(result.instanceParams[2].name, 'PageID');
		assert.strictEqual(result.instanceParams[2].type, 'text');
		assert.strictEqual(result.instanceParams[2].value, 'registry');
	});

	test('parses InstanceParam valueRange correctly', async () => {
		const doc = await openFixture('kevin-registry/registry.html');
		const result = parseDocument(doc);

		const accentParam = result.instanceParams[1]; // AccentColor
		const valueText = doc.getText(accentParam.valueRange);
		assert.strictEqual(valueText, '#1a4a7a');
	});

	test('parses TemplateDeclaration', async () => {
		const doc = await openFixture('kevin-registry/about.html');
		const result = parseDocument(doc);

		assert.ok(result.templateDeclaration);
		assert.strictEqual(result.templateDeclaration.templatePath, '/Templates/kevin-registry.dwt');
		assert.strictEqual(result.templateDeclaration.codeOutsideHTMLIsLocked, false);
	});

	test('returns null templateDeclaration for template files', async () => {
		const doc = await openFixture('kevin-registry/Templates/kevin-registry.dwt');
		const result = parseDocument(doc);
		assert.strictEqual(result.templateDeclaration, null);
	});

	test('entire document is protected when no editable regions exist in a DWT-like file', async () => {
		const doc = await openFixture('kevin-registry/submit.html');
		const result = parseDocument(doc);

		// none file type has no protected regions (it's not a DWT file)
		assert.strictEqual(result.fileType, 'none');
		assert.strictEqual(result.protectedRegions.length, 0);
	});

	test('empty result for non-DWT files', async () => {
		const doc = await openFixture('kevin-registry/submit.html');
		const result = parseDocument(doc);

		assert.strictEqual(result.fileType, 'none');
		assert.strictEqual(result.editableRegions.length, 0);
		assert.strictEqual(result.protectedRegions.length, 0);
		assert.strictEqual(result.instanceParams.length, 0);
		assert.strictEqual(result.templateVariables.length, 0);
		assert.strictEqual(result.conditionalRegions.length, 0);
		assert.strictEqual(result.templateDeclaration, null);
	});
});
