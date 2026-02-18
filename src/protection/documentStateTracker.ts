import { DwtParseResult } from '../parser/types';

interface DocumentState {
	/** Whether we are currently reverting a blocked edit */
	isReverting: boolean;
	/** Whether a programmatic edit (e.g. from properties panel) is in progress */
	isProgrammaticEdit: boolean;
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
				isProgrammaticEdit: false,
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
		this.getState(uri).isProgrammaticEdit = true;
	}

	endProgrammaticEdit(uri: string): void {
		this.getState(uri).isProgrammaticEdit = false;
	}

	isProgrammaticEdit(uri: string): boolean {
		return this.getState(uri).isProgrammaticEdit;
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
