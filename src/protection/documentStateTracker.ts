import { DwtParseResult } from '../parser/types';

interface DocumentState {
	/** Whether we are currently reverting a blocked edit */
	isReverting: boolean;
	/** Number of concurrent programmatic edits in progress (0 = none).
	 *  A counter rather than a boolean lets overlapping async callers
	 *  (e.g. two rapid webview write-backs) each own an independent
	 *  begin/end pair without one caller clearing the other's flag. */
	programmaticEditCount: number;
	/** Last known parse result (from before the most recent edit) */
	lastParseResult: DwtParseResult | null;
}

/**
 * Tracks per-document state to prevent infinite revert loops
 * and allow programmatic edits to bypass protection.
 */
export class DocumentStateTracker {
	private states = new Map<string, DocumentState>();

	private getState(uri: string): DocumentState {
		let state = this.states.get(uri);
		if (!state) {
			state = {
				isReverting: false,
				programmaticEditCount: 0,
				lastParseResult: null,
			};
			this.states.set(uri, state);
		}
		return state;
	}

	beginRevert(uri: string): void {
		this.getState(uri).isReverting = true;
	}

	endRevert(uri: string): void {
		this.getState(uri).isReverting = false;
	}

	isReverting(uri: string): boolean {
		return this.getState(uri).isReverting;
	}

	beginProgrammaticEdit(uri: string): void {
		this.getState(uri).programmaticEditCount++;
	}

	endProgrammaticEdit(uri: string): void {
		const state = this.getState(uri);
		if (state.programmaticEditCount > 0) {
			state.programmaticEditCount--;
		}
	}

	isProgrammaticEdit(uri: string): boolean {
		return this.getState(uri).programmaticEditCount > 0;
	}

	setLastParseResult(uri: string, result: DwtParseResult): void {
		this.getState(uri).lastParseResult = result;
	}

	getLastParseResult(uri: string): DwtParseResult | null {
		return this.getState(uri).lastParseResult;
	}

	/** Remove state for a closed document. */
	remove(uri: string): void {
		this.states.delete(uri);
	}

	clear(): void {
		this.states.clear();
	}
}
