import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { handleTemplateRename } from '../../src/template/templateRenameHandler';

// ---------------------------------------------------------------------------
// handleTemplateRename — string-substitution behaviour
// ---------------------------------------------------------------------------

suite('handleTemplateRename', () => {
	let tmpDir: string;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwt-rename-test-'));
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('updates InstanceBegin template path in an HTML instance file', async function () {
		// This test requires a workspace folder that includes tmpDir as the root.
		// Without workspace folders, handleTemplateRename exits early — skip.
		const firstFolder = vscode.workspace.workspaceFolders?.[0];
		if (!firstFolder) { this.skip(); return; }

		// Use the first workspace folder as the site root
		const siteRoot = firstFolder.uri.fsPath;

		// Create a Templates directory and instance file under the workspace root
		const templatesDir = path.join(siteRoot, '_test_templates_rename');
		const instanceDir = path.join(siteRoot, '_test_instances_rename');
		fs.mkdirSync(templatesDir, { recursive: true });
		fs.mkdirSync(instanceDir, { recursive: true });

		const oldDwtPath = path.join(templatesDir, 'old-name.dwt');
		const newDwtPath = path.join(templatesDir, 'new-name.dwt');
		fs.writeFileSync(oldDwtPath, '<html></html>', 'utf-8');

		// Derive site-relative paths (with leading slash)
		const oldRelative = oldDwtPath.replace(/\\/g, '/').slice(siteRoot.replace(/\\/g, '/').length);
		const newRelative = newDwtPath.replace(/\\/g, '/').slice(siteRoot.replace(/\\/g, '/').length);

		// Create an instance HTML file with InstanceBegin referencing the old path
		const instanceHtml = `<!DOCTYPE html>
<html lang="en"><!-- InstanceBegin template="${oldRelative}" codeOutsideHTMLIsLocked="false" -->
<head></head>
<body><!-- InstanceBeginEditable name="main" -->content<!-- InstanceEndEditable --></body>
<!-- InstanceEnd --></html>
`;
		const instanceFile = path.join(instanceDir, 'page.html');
		fs.writeFileSync(instanceFile, instanceHtml, 'utf-8');

		try {
			await handleTemplateRename(
				vscode.Uri.file(oldDwtPath),
				vscode.Uri.file(newDwtPath),
			);

			// After renaming, the instance file should reference newRelative
			// Allow a moment for any async saves to complete
			await new Promise(r => setTimeout(r, 200));

			const updated = fs.readFileSync(instanceFile, 'utf-8');
			assert.ok(
				updated.includes(`template="${newRelative}"`),
				`Expected new path "${newRelative}" in updated file.\nGot:\n${updated}`,
			);
			assert.ok(
				!updated.includes(`template="${oldRelative}"`),
				`Old path "${oldRelative}" should no longer appear in the file.`,
			);
		} finally {
			// Clean up created fixture directories
			fs.rmSync(templatesDir, { recursive: true, force: true });
			fs.rmSync(instanceDir, { recursive: true, force: true });
		}
	});

	test('does nothing when template is not under a workspace folder', async () => {
		// Use a path completely outside the workspace — should return without error
		const outsidePath = path.join(os.tmpdir(), 'outside-workspace');
		const oldUri = vscode.Uri.file(path.join(outsidePath, 'old.dwt'));
		const newUri = vscode.Uri.file(path.join(outsidePath, 'new.dwt'));

		// Should complete without throwing regardless of workspace state
		await assert.doesNotReject(
			() => handleTemplateRename(oldUri, newUri),
			'handleTemplateRename should not throw for out-of-workspace paths',
		);
	});

	test('escapeRegExp is safe for paths with special regex characters', async function () {
		// Guard: if the old template path contains regex special chars (e.g. dots),
		// the substitution should still be literal. We test indirectly by ensuring
		// a path like "/Templates/site.v2/main.dwt" is handled without throwing.
		const firstFolder = vscode.workspace.workspaceFolders?.[0];
		if (!firstFolder) { this.skip(); return; }

		const siteRoot = firstFolder.uri.fsPath;
		const specialDir = path.join(siteRoot, '_test.special.v2');
		fs.mkdirSync(specialDir, { recursive: true });

		const oldPath = path.join(specialDir, 'main.dwt');
		const newPath = path.join(specialDir, 'main-v2.dwt');

		try {
			await assert.doesNotReject(
				() => handleTemplateRename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath)),
				'handleTemplateRename should not throw for paths with special characters',
			);
		} finally {
			fs.rmSync(specialDir, { recursive: true, force: true });
		}
	});
});
