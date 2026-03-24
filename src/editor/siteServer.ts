import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.ico': 'image/x-icon',
	'.json': 'application/json',
};

export interface SiteServer {
	readonly url: string;
	readonly port: number;
	dispose(): void;
}

export function startSiteServer(siteRoot: string): Promise<SiteServer> {
	const normalizedRoot = path.resolve(siteRoot);

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
			const absPath = path.resolve(path.join(normalizedRoot, pathname));

			if (!absPath.startsWith(normalizedRoot + path.sep) && absPath !== normalizedRoot) {
				res.writeHead(403);
				res.end();
				return;
			}

			fs.readFile(absPath, (err, data) => {
				if (err) {
					res.writeHead(404);
					res.end();
					return;
				}
				const ct = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
				res.writeHead(200, { 'Content-Type': ct });
				res.end(data);
			});
		});

		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				url: `http://localhost:${port}`,
				port,
				dispose: () => server.close(),
			});
		});

		server.on('error', reject);
	});
}
