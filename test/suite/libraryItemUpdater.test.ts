import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { applyLibraryItemToFile } from '../../src/library/libraryItemUpdater';

const fixturesPath = path.resolve(__dirname, '../../../test');

// ---------------------------------------------------------------------------
// applyLibraryItemToFile
// ---------------------------------------------------------------------------

suite('applyLibraryItemToFile', () => {
	let tmpDir: string;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwt-test-'));
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('replaces content between matching BeginLibraryItem/EndLibraryItem markers', async () => {
		const lbiContent = '<p>NEW CONTENT</p>\n';

		// Create a temp file with a matching LBI block
		const htmlContent = `<html><body>
<!-- #BeginLibraryItem "/Library/contact-widget.lbi" --><p>OLD CONTENT</p><!-- #EndLibraryItem -->
</body></html>`;
		const htmlFile = path.join(tmpDir, 'test.html');
		fs.writeFileSync(htmlFile, htmlContent, 'utf-8');

		const lbiFile = path.join(tmpDir, 'Library', 'contact-widget.lbi');
		fs.mkdirSync(path.join(tmpDir, 'Library'), { recursive: true });
		fs.writeFileSync(lbiFile, lbiContent, 'utf-8');

		const fileUri = vscode.Uri.file(htmlFile);
		const lbiUri = vscode.Uri.file(lbiFile);

		const result = await applyLibraryItemToFile(fileUri, lbiUri, lbiContent);
		assert.strictEqual(result.success, true, `Expected success, got error: ${result.error}`);

		// Verify the file was updated
		const updated = fs.readFileSync(htmlFile, 'utf-8');
		assert.ok(updated.includes('<p>NEW CONTENT</p>'), 'New content should be present');
		assert.ok(!updated.includes('<p>OLD CONTENT</p>'), 'Old content should be replaced');
	});

	test('replaces multiple occurrences of the same LBI in one file', async () => {
		const lbiContent = '<p>UPDATED</p>\n';

		const lbiFile = path.join(tmpDir, 'Library', 'widget.lbi');
		fs.mkdirSync(path.join(tmpDir, 'Library'), { recursive: true });
		fs.writeFileSync(lbiFile, lbiContent, 'utf-8');

		const htmlContent = `<html><body>
<div><!-- #BeginLibraryItem "/Library/widget.lbi" --><p>first</p><!-- #EndLibraryItem --></div>
<div><!-- #BeginLibraryItem "/Library/widget.lbi" --><p>second</p><!-- #EndLibraryItem --></div>
</body></html>`;
		const htmlFile = path.join(tmpDir, 'page.html');
		fs.writeFileSync(htmlFile, htmlContent, 'utf-8');

		const result = await applyLibraryItemToFile(
			vscode.Uri.file(htmlFile),
			vscode.Uri.file(lbiFile),
			lbiContent,
		);

		assert.strictEqual(result.success, true, `Expected success, got error: ${result.error}`);
		const updated = fs.readFileSync(htmlFile, 'utf-8');
		const count = (updated.match(/<p>UPDATED<\/p>/g) || []).length;
		assert.strictEqual(count, 2, 'Both occurrences should be replaced');
		assert.ok(!updated.includes('<p>first</p>'), 'First old content should be gone');
		assert.ok(!updated.includes('<p>second</p>'), 'Second old content should be gone');
	});

	test('does not modify files with no matching LBI reference', async () => {
		const lbiContent = '<p>new</p>\n';

		const lbiFile = path.join(tmpDir, 'Library', 'other.lbi');
		fs.mkdirSync(path.join(tmpDir, 'Library'), { recursive: true });
		fs.writeFileSync(lbiFile, lbiContent, 'utf-8');

		// This file references a DIFFERENT lbi
		const htmlContent = `<html><body>
<!-- #BeginLibraryItem "/Library/something-else.lbi" --><p>keep</p><!-- #EndLibraryItem -->
</body></html>`;
		const htmlFile = path.join(tmpDir, 'unchanged.html');
		fs.writeFileSync(htmlFile, htmlContent, 'utf-8');

		const result = await applyLibraryItemToFile(
			vscode.Uri.file(htmlFile),
			vscode.Uri.file(lbiFile),
			lbiContent,
		);

		// Should succeed but make no change
		assert.strictEqual(result.success, true);
		const updated = fs.readFileSync(htmlFile, 'utf-8');
		assert.ok(updated.includes('<p>keep</p>'), 'Content of unrelated LBI should be unchanged');
	});

	test('handles LBI content spanning multiple lines', async () => {
		const newContent = '<p>Line 1</p>\n<p>Line 2</p>\n';

		const lbiFile = path.join(tmpDir, 'Library', 'multi.lbi');
		fs.mkdirSync(path.join(tmpDir, 'Library'), { recursive: true });
		fs.writeFileSync(lbiFile, newContent, 'utf-8');

		const htmlContent = `<html><body>
<!-- #BeginLibraryItem "/Library/multi.lbi" -->
<p>Old line 1</p>
<p>Old line 2</p>
<!-- #EndLibraryItem -->
</body></html>`;
		const htmlFile = path.join(tmpDir, 'multi.html');
		fs.writeFileSync(htmlFile, htmlContent, 'utf-8');

		const result = await applyLibraryItemToFile(
			vscode.Uri.file(htmlFile),
			vscode.Uri.file(lbiFile),
			newContent,
		);

		assert.strictEqual(result.success, true, `Expected success, got error: ${result.error}`);
		const updated = fs.readFileSync(htmlFile, 'utf-8');
		assert.ok(updated.includes('<p>Line 1</p>'), 'New content line 1 should be present');
		assert.ok(!updated.includes('<p>Old line 1</p>'), 'Old content should be replaced');
	});

	test('returns success=false for non-existent file', async () => {
		const lbiFile = path.join(tmpDir, 'Library', 'x.lbi');
		fs.mkdirSync(path.join(tmpDir, 'Library'), { recursive: true });
		fs.writeFileSync(lbiFile, '<p>x</p>', 'utf-8');

		const result = await applyLibraryItemToFile(
			vscode.Uri.file(path.join(tmpDir, 'nonexistent.html')),
			vscode.Uri.file(lbiFile),
			'<p>x</p>',
		);

		assert.strictEqual(result.success, false, 'Should fail for missing file');
	});

	test('works with actual fixture file when workspace is available', async function () {
		// This test requires the workspace to include the test fixture folder.
		// Skip it if no workspace folders are configured (e.g. bare test run).
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			this.skip();
		}

		const lbiUri = vscode.Uri.file(
			path.join(fixturesPath, 'kevin-registry/Library/contact-widget.lbi'),
		);
		const lbiBytes = await vscode.workspace.fs.readFile(lbiUri);
		const lbiText = Buffer.from(lbiBytes).toString('utf-8');

		// Make a temp copy of foia.html to avoid modifying the fixture
		const sourceHtml = path.join(fixturesPath, 'kevin-registry/foia.html');
		const tmpHtml = path.join(tmpDir, 'foia.html');
		fs.copyFileSync(sourceHtml, tmpHtml);

		// Create a matching Library folder structure so resolveLbiPath succeeds
		const libDir = path.join(tmpDir, 'Library');
		fs.mkdirSync(libDir, { recursive: true });
		fs.copyFileSync(lbiUri.fsPath, path.join(libDir, 'contact-widget.lbi'));

		const result = await applyLibraryItemToFile(
			vscode.Uri.file(tmpHtml),
			lbiUri,
			lbiText,
		);

		// At minimum should not fail
		assert.strictEqual(result.success, true, `applyLibraryItemToFile failed: ${result.error}`);
	});
});
