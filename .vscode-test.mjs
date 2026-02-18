import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'dist/test/suite/**/*.test.js',
	mocha: {
		timeout: 20000,
	},
});
