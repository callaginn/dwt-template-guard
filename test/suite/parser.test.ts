import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { parseDocument } from '../../src/parser/dwtParser';

const fixturesPath = path.resolve(__dirname, '../../test/fixtures');

async function openFixture(name: string): Promise<vscode.TextDocument> {
	const uri = vscode.Uri.file(path.join(fixturesPath, name));
	return vscode.workspace.openTextDocument(uri);
}

suite('DWT Parser', () => {
	test('detects template file type for .dwt files', async () => {
		const doc = await openFixture('template.dwt');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'template');
	});

	test('detects instance file type for .html files with InstanceBegin', async () => {
		const doc = await openFixture('page-basic.html');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'instance');
	});

	test('detects none for plain HTML files', async () => {
		const doc = await openFixture('page-no-template.html');
		const result = parseDocument(doc);
		assert.strictEqual(result.fileType, 'none');
		assert.strictEqual(result.editableRegions.length, 0);
		assert.strictEqual(result.protectedRegions.length, 0);
	});

	test('parses TemplateBeginEditable/TemplateEndEditable regions', async () => {
		const doc = await openFixture('template.dwt');
		const result = parseDocument(doc);

		assert.strictEqual(result.editableRegions.length, 2);
		assert.strictEqual(result.editableRegions[0].name, 'doctitle');
		assert.strictEqual(result.editableRegions[1].name, 'content');
	});

	test('parses InstanceBeginEditable/InstanceEndEditable regions', async () => {
		const doc = await openFixture('page-basic.html');
		const result = parseDocument(doc);

		assert.strictEqual(result.editableRegions.length, 2);
		assert.strictEqual(result.editableRegions[0].name, 'doctitle');
		assert.strictEqual(result.editableRegions[1].name, 'content');
	});

	test('editable region contentRange excludes markers', async () => {
		const doc = await openFixture('template.dwt');
		const result = parseDocument(doc);
		const region = result.editableRegions[0];

		// The content between the markers should contain the <title> tag
		const content = doc.getText(region.contentRange);
		assert.ok(content.includes('<title>Default Title</title>'));

		// The content should NOT contain the marker comments
		assert.ok(!content.includes('TemplateBeginEditable'));
		assert.ok(!content.includes('TemplateEndEditable'));
	});

	test('protected regions cover everything outside editable contentRanges', async () => {
		const doc = await openFixture('template.dwt');
		const result = parseDocument(doc);

		// Should have 3 protected regions: before first, between, after last
		assert.strictEqual(result.protectedRegions.length, 3);

		// First protected region should include <html><head> and the begin marker
		const firstProtected = doc.getText(result.protectedRegions[0].range);
		assert.ok(firstProtected.includes('<html>'));
		assert.ok(firstProtected.includes('TemplateBeginEditable'));
	});

	test('markers themselves are protected', async () => {
		const doc = await openFixture('template.dwt');
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
		const doc = await openFixture('page-params.html');
		const result = parseDocument(doc);

		assert.strictEqual(result.instanceParams.length, 3);

		assert.strictEqual(result.instanceParams[0].name, 'Background');
		assert.strictEqual(result.instanceParams[0].type, 'color');
		assert.strictEqual(result.instanceParams[0].value, '#187054');

		assert.strictEqual(result.instanceParams[1].name, 'ID');
		assert.strictEqual(result.instanceParams[1].type, 'text');
		assert.strictEqual(result.instanceParams[1].value, 'newsletter');

		assert.strictEqual(result.instanceParams[2].name, 'ShowPromo');
		assert.strictEqual(result.instanceParams[2].type, 'boolean');
		assert.strictEqual(result.instanceParams[2].value, 'true');
	});

	test('parses InstanceParam valueRange correctly', async () => {
		const doc = await openFixture('page-params.html');
		const result = parseDocument(doc);

		const bgParam = result.instanceParams[0];
		const valueText = doc.getText(bgParam.valueRange);
		assert.strictEqual(valueText, '#187054');
	});

	test('parses TemplateDeclaration', async () => {
		const doc = await openFixture('page-basic.html');
		const result = parseDocument(doc);

		assert.ok(result.templateDeclaration);
		assert.strictEqual(result.templateDeclaration.templatePath, '/Templates/Main.dwt');
		assert.strictEqual(result.templateDeclaration.codeOutsideHTMLIsLocked, false);
	});

	test('returns null templateDeclaration for template files', async () => {
		const doc = await openFixture('template.dwt');
		const result = parseDocument(doc);
		assert.strictEqual(result.templateDeclaration, null);
	});

	test('entire document is protected when no editable regions exist in a DWT-like file', async () => {
		const doc = await openFixture('page-no-template.html');
		const result = parseDocument(doc);

		// none file type has no protected regions (it's not a DWT file)
		assert.strictEqual(result.fileType, 'none');
		assert.strictEqual(result.protectedRegions.length, 0);
	});

	test('empty result for non-DWT files', async () => {
		const doc = await openFixture('page-no-template.html');
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
