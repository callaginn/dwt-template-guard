import * as assert from 'assert';
import * as vscode from 'vscode';
import { rangeOverlaps, rangeContains } from '../../src/utils/rangeUtils';

function range(sl: number, sc: number, el: number, ec: number): vscode.Range {
	return new vscode.Range(
		new vscode.Position(sl, sc),
		new vscode.Position(el, ec),
	);
}

suite('Range Utilities', () => {
	test('rangeOverlaps: non-overlapping ranges', () => {
		const a = range(0, 0, 1, 0);
		const b = range(2, 0, 3, 0);
		assert.strictEqual(rangeOverlaps(a, b), false);
		assert.strictEqual(rangeOverlaps(b, a), false);
	});

	test('rangeOverlaps: fully overlapping ranges', () => {
		const a = range(0, 0, 5, 0);
		const b = range(1, 0, 3, 0);
		assert.strictEqual(rangeOverlaps(a, b), true);
		assert.strictEqual(rangeOverlaps(b, a), true);
	});

	test('rangeOverlaps: partial overlap', () => {
		const a = range(0, 0, 3, 0);
		const b = range(2, 0, 5, 0);
		assert.strictEqual(rangeOverlaps(a, b), true);
		assert.strictEqual(rangeOverlaps(b, a), true);
	});

	test('rangeOverlaps: adjacent but non-overlapping (end of A = start of B)', () => {
		const a = range(0, 0, 2, 0);
		const b = range(2, 0, 4, 0);
		assert.strictEqual(rangeOverlaps(a, b), false);
	});

	test('rangeOverlaps: identical ranges', () => {
		const a = range(1, 0, 3, 0);
		const b = range(1, 0, 3, 0);
		assert.strictEqual(rangeOverlaps(a, b), true);
	});

	test('rangeContains: outer fully contains inner', () => {
		const outer = range(0, 0, 10, 0);
		const inner = range(2, 0, 5, 0);
		assert.strictEqual(rangeContains(outer, inner), true);
	});

	test('rangeContains: outer does not contain inner', () => {
		const outer = range(0, 0, 3, 0);
		const inner = range(2, 0, 5, 0);
		assert.strictEqual(rangeContains(outer, inner), false);
	});

	test('rangeContains: identical ranges', () => {
		const a = range(1, 0, 3, 0);
		assert.strictEqual(rangeContains(a, a), true);
	});
});
