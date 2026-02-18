import * as vscode from 'vscode';

/** Returns true if two ranges overlap (share any common area). */
export function rangeOverlaps(a: vscode.Range, b: vscode.Range): boolean {
	if (a.end.isBeforeOrEqual(b.start)) return false;
	if (a.start.isAfterOrEqual(b.end)) return false;
	return true;
}

/** Returns true if the outer range fully contains the inner range. */
export function rangeContains(outer: vscode.Range, inner: vscode.Range): boolean {
	return outer.start.isBeforeOrEqual(inner.start) && outer.end.isAfterOrEqual(inner.end);
}
