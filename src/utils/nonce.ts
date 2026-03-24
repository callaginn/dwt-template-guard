import { randomBytes } from 'crypto';

/** Generate a cryptographically secure nonce for CSP-compliant webview scripts. */
export function getNonce(): string {
	return randomBytes(16).toString('base64');
}
