/**
 * Lightweight HTML-to-Markdown converter for Dreamweaver template content.
 * Handles common HTML elements found in DWT editable regions.
 */
export function htmlToMarkdown(html: string): string {
	let text = html;

	// Normalize line endings
	text = text.replace(/\r\n/g, '\n');

	// ── Inline elements (process before block elements) ──

	text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
	text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
	text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
	text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
	text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

	// Images (handle alt before src and src before alt orderings)
	text = text.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
	text = text.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
	text = text.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

	// Inline code
	text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

	// Line breaks
	text = text.replace(/<br\s*\/?>/gi, '\n');

	// ── Block elements ──

	// Code blocks (before general tag stripping)
	text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
	text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

	// Headings
	for (let i = 6; i >= 1; i--) {
		const hashes = '#'.repeat(i);
		const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
		text = text.replace(re, (_, content) =>
			`\n${hashes} ${stripTags(content).trim()}\n`,
		);
	}

	// Unordered lists
	text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
		const items = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
			(_m: string, li: string) => `- ${stripTags(li).trim()}\n`,
		);
		return '\n' + stripTags(items) + '\n';
	});

	// Ordered lists
	text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
		let n = 0;
		const items = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
			(_m: string, li: string) => { n++; return `${n}. ${stripTags(li).trim()}\n`; },
		);
		return '\n' + stripTags(items) + '\n';
	});

	// Blockquotes
	text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) =>
		stripTags(content).trim().split('\n').map((line: string) => `> ${line}`).join('\n') + '\n',
	);

	// Paragraphs and divs → double newlines
	text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
	text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

	// Horizontal rules
	text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

	// ── Cleanup ──

	// Strip remaining HTML tags
	text = stripTags(text);

	// Decode common HTML entities
	text = decodeEntities(text);

	// Collapse excessive blank lines
	text = text.replace(/\n{3,}/g, '\n\n');

	return text.trim();
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}
