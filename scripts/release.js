const { readFileSync, writeFileSync } = require('fs');
const { execSync } = require('child_process');

const c = {
	reset: '\x1b[0m',
	bold:  '\x1b[1m',
	dim:   '\x1b[2m',
	green: '\x1b[32m',
};

function select(version, options) {
	return new Promise((resolve) => {
		let index = 0;
		const W = 37; // inner width between │ borders
		const totalLines = 13; // 12 box lines + 1 blank below

		const b  = (s) => `${c.dim}${s}${c.reset}`;  // dim border char
		const row = (content, visLen) =>
			`${b('│')}${content}${' '.repeat(W - visLen)}${b('│')}`;

		const render = (first = false) => {
			if (!first) process.stdout.write(`\x1b[${totalLines}A`);

			const lines = [
				b(`╭${'─'.repeat(W)}╮`),
				row(`  ${c.bold}DWT Guard  ·  Release Builder${c.reset}`, 32),
				b(`├${'─'.repeat(W)}┤`),
				row('', 0),
				row(`  ${c.dim}Current version${c.reset}  ${c.bold}${version}${c.reset}`, 19 + version.length),
				row('', 0),
				...options.map((opt, i) => {
					const visLen = 15 + opt.next.length;
					if (i === index) {
						return row(
							`  ${c.green}${c.bold}❯  ${opt.label.padEnd(7)}${c.reset}${c.dim}→${c.reset}  ${c.green}${c.bold}${opt.next}${c.reset}`,
							visLen
						);
					} else {
						return row(
							`${c.dim}  ·  ${opt.label.padEnd(7)}→  ${opt.next}${c.reset}`,
							visLen
						);
					}
				}),
				row('', 0),
				row(`  ${c.dim}↑↓ to move  ·  enter to confirm${c.reset}`, 33),
				b(`╰${'─'.repeat(W)}╯`),
				'',
			];

			lines.forEach((line) => process.stdout.write(`\x1b[2K${line}\n`));
		};

		render(true);

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		process.stdin.on('data', (key) => {
			if (key === '\x1b[A' && index > 0) {
				index--;
				render();
			} else if (key === '\x1b[B' && index < options.length - 1) {
				index++;
				render();
			} else if (key === '\r' || key === '\n') {
				process.stdin.setRawMode(false);
				process.stdin.pause();
				process.stdout.write(`\x1b[${totalLines}A`);
				for (let i = 0; i < totalLines; i++) process.stdout.write('\x1b[2K\n');
				process.stdout.write(`\x1b[${totalLines}A`);
				resolve(index);
			} else if (key === '\x03') {
				process.stdout.write('\n');
				process.exit();
			}
		});
	});
}

(async () => {
	const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
	const [major, minor, patch] = pkg.version.split('.').map(Number);

	const types = ['patch', 'minor', 'major'];
	const versions = {
		patch: `${major}.${minor}.${patch + 1}`,
		minor: `${major}.${minor + 1}.0`,
		major: `${major + 1}.0.0`,
	};
	const options = types.map((t) => ({ label: t, next: versions[t] }));

	console.log();
	const chosen = await select(pkg.version, options);
	const type = types[chosen];
	const newVersion = versions[type];

	console.log(`  ${c.green}${c.bold}✓${c.reset}  ${c.bold}${newVersion}${c.reset}  ${c.dim}(${type} release)${c.reset}\n`);

	pkg.version = newVersion;
	writeFileSync('./package.json', JSON.stringify(pkg, null, '\t') + '\n');

	const pm = process.env.npm_execpath?.includes('yarn') ? 'yarn' : 'npm';
	execSync(`${pm} run vsix`, { stdio: 'inherit' });
	execSync(`code --install-extension releases/dwt-template-guard-${newVersion}.vsix`, { stdio: 'inherit' });
})();
