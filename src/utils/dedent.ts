/**
 * Remove the minimum common leading indentation from all non-empty lines.
 * Tabs are converted to spaces using `tabSize` for comparison, but original
 * indentation characters are preserved in the relative indentation that remains.
 */
export function dedentBlock(text: string, tabSize: number = 4): string {
	const lines = text.split('\n');

	// Find minimum indentation (in space-equivalents) across non-empty lines
	let minIndent = Infinity;
	for (const line of lines) {
		if (line.trim() === '') continue;
		minIndent = Math.min(minIndent, measureIndent(line, tabSize));
	}

	if (minIndent === 0 || minIndent === Infinity) return text;

	// Strip that many space-equivalents from the start of each line
	return lines
		.map((line) => (line.trim() === '' ? line : stripLeading(line, minIndent, tabSize)))
		.join('\n');
}

/** Count leading whitespace as a number of space-equivalents. */
function measureIndent(line: string, tabSize: number): number {
	let indent = 0;
	for (const ch of line) {
		if (ch === ' ') indent += 1;
		else if (ch === '\t') indent += tabSize;
		else break;
	}
	return indent;
}

/**
 * Remove `amount` space-equivalents of leading whitespace from a line.
 * If a tab straddles the boundary, it is consumed and the overshoot is
 * emitted as spaces so that alignment is preserved.
 */
function stripLeading(line: string, amount: number, tabSize: number): string {
	let removed = 0;
	let i = 0;

	while (i < line.length && removed < amount) {
		if (line[i] === ' ') {
			removed += 1;
			i++;
		} else if (line[i] === '\t') {
			if (removed + tabSize <= amount) {
				removed += tabSize;
				i++;
			} else {
				// Tab would overshoot — consume it, emit the leftover as spaces
				const overshoot = removed + tabSize - amount;
				i++;
				return ' '.repeat(overshoot) + line.slice(i);
			}
		} else {
			break;
		}
	}

	return line.slice(i);
}
