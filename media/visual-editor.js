(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const toolbar = document.getElementById('toolbar');
	const headRegionsEl = document.getElementById('head-regions');
	const container = document.getElementById('editor-container');
	const regionIndicator = document.getElementById('region-indicator');

	/** @type {Record<string, ReturnType<typeof setTimeout>>} */
	const debounceTimers = {};

	/** Injected <style>/<link> elements from the previous render. */
	let injectedStyleEls = [];

	/** CSP nonce for dynamically created style/link elements. Set on first render. */
	let styleNonce = '';

	/** Saved selection range for the async Insert Link flow. */
	let pendingLinkRange = null;

	/** Last-rendered innerHTML per region name — used to skip no-op write-backs. */
	const lastRenderedHtml = {};

	// ── Boot ─────────────────────────────────────────

	vscode.postMessage({ type: 'ready' });

	// Floating toolbar built once at boot
	setupToolbar();

	// Container-level click listener (added once, not per render)
	container.addEventListener('click', (e) => {
		if (!e.target.closest('dwt-region')) {
			deactivateAllRegions();
		}
	});

	// Selection-change → show/hide/position the floating toolbar
	// Show on click (collapsed cursor) OR text selection, as long as inside a region
	document.addEventListener('selectionchange', () => {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			hideToolbar();
			return;
		}
		const range = sel.getRangeAt(0);
		const anchor = range.commonAncestorContainer;
		const anchorEl = anchor.nodeType === Node.ELEMENT_NODE
			? /** @type {Element} */ (anchor)
			: anchor.parentElement;
		if (!anchorEl || !anchorEl.closest('dwt-region')) {
			hideToolbar();
			return;
		}
		positionToolbar(range);
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'render':
				if (message.nonce) {
					styleNonce = message.nonce;
				}
				renderPage(
					message.styles,
					message.bodyContent,
					message.bodyAttrs,
					message.headRegions,
				);
				break;

			case 'linkUrl':
				// Response from extension host for the Insert Link flow
				if (message.url && pendingLinkRange) {
					const sel = window.getSelection();
					if (sel) {
						sel.removeAllRanges();
						sel.addRange(pendingLinkRange);
						// Wrap the saved selection in an <a> element
						const anchor = document.createElement('a');
						anchor.href = message.url;
						try {
							pendingLinkRange.surroundContents(anchor);
						} catch {
							const fragment = pendingLinkRange.extractContents();
							anchor.appendChild(fragment);
							pendingLinkRange.insertNode(anchor);
						}
					}
					const activeRegion = findActiveRegion();
					if (activeRegion) {
						debounceSendChange(activeRegion.getAttribute('data-region'), activeRegion);
					}
				}
				pendingLinkRange = null;
				break;
		}
	});

	// ── Render ───────────────────────────────────────

	/**
	 * @param {string} styles      - <style> and <link> tags extracted from <head>
	 * @param {string} bodyContent - inner HTML of <body>
	 * @param {string} bodyAttrs   - attributes from the <body> tag (e.g. id, class, data-*)
	 * @param {{ name: string; content: string }[]} headRegions
	 */
	async function renderPage(styles, bodyContent, bodyAttrs, headRegions) {
		// Clear pending debounce timers from previous render
		for (const key of Object.keys(debounceTimers)) {
			clearTimeout(debounceTimers[key]);
			delete debounceTimers[key];
		}

		// Inject new styles into <head>, keeping old ones in place until
		// all new <link> stylesheets have loaded to prevent FOUC.
		const oldStyleEls = injectedStyleEls;
		injectedStyleEls = [];

		/** @type {Promise<void>[]} */
		const linkLoads = [];

		if (styles) {
			const temp = document.createElement('div');
			temp.innerHTML = styles;
			for (const child of Array.from(temp.children)) {
				if (styleNonce) {
					child.setAttribute('nonce', styleNonce);
				}
				// Track <link> load events so we can wait for them
				if (child.tagName === 'LINK') {
					linkLoads.push(new Promise((resolve) => {
						child.addEventListener('load', resolve, { once: true });
						child.addEventListener('error', resolve, { once: true });
					}));
				}
				document.head.appendChild(child);
				injectedStyleEls.push(child);
			}
		}

		// Wait for all new stylesheets to finish loading
		if (linkLoads.length > 0) {
			await Promise.all(linkLoads);
		}

		// Now safe to remove old style elements
		for (const el of oldStyleEls) {
			el.remove();
		}

		// Apply body attributes (id, class, data-*) to the container
		if (bodyAttrs) {
			const wrapper = document.createElement('div');
			wrapper.innerHTML = '<div ' + bodyAttrs.trim() + '></div>';
			const parsed = wrapper.firstElementChild;
			if (parsed) {
				// Clear old body-forwarded attributes
				for (const attr of Array.from(container.attributes)) {
					if (attr.name !== 'id') {
						container.removeAttribute(attr.name);
					}
				}
				for (const attr of Array.from(parsed.attributes)) {
					if (attr.name === 'id') {
						container.setAttribute('data-page-id', attr.value);
					} else {
						container.setAttribute(attr.name, attr.value);
					}
				}
			}
		}

		// Inject the body content
		container.innerHTML = bodyContent;

		setupEditableRegions();
		updateHeadRegions(headRegions);
		hideToolbar();
	}

	// ── Editable regions ─────────────────────────────

	function setupEditableRegions() {
		const regions = container.querySelectorAll('dwt-region[data-region]');
		regions.forEach((region) => {
			// Add visual label
			const label = document.createElement('div');
			label.className = 'dwt-region-label';
			label.textContent = region.getAttribute('data-region');
			region.prepend(label);

			// Snapshot the browser-normalized innerHTML as the baseline
			// (clone without label to match what debounceSendChange extracts)
			const snapshot = region.cloneNode(true);
			const snapLabel = snapshot.querySelector('.dwt-region-label');
			if (snapLabel) { snapLabel.remove(); }
			lastRenderedHtml[region.getAttribute('data-region')] = snapshot.innerHTML;

			// Content change detection
			region.addEventListener('input', () => {
				const name = region.getAttribute('data-region');
				debounceSendChange(name, region);
			});

			// Focus tracking
			region.addEventListener('focus', () => {
				activateRegion(region);
			});

			region.addEventListener('click', (e) => {
				e.stopPropagation(); // Prevent container click handler
				activateRegion(region);
			});
		});
	}

	/**
	 * @param {Element} regionEl
	 */
	function activateRegion(regionEl) {
		const name = regionEl.getAttribute('data-region');
		showRegionIndicator(name);

		container.querySelectorAll('dwt-region').forEach((r) => {
			r.classList.toggle('dwt-region--active', r === regionEl);
		});

		vscode.postMessage({ type: 'focusRegion', name });
	}

	function deactivateAllRegions() {
		hideRegionIndicator();
		container.querySelectorAll('dwt-region').forEach((r) => {
			r.classList.remove('dwt-region--active');
		});
	}

	/**
	 * @param {string} name
	 * @param {Element} regionEl
	 */
	function debounceSendChange(name, regionEl) {
		if (debounceTimers[name]) {
			clearTimeout(debounceTimers[name]);
		}
		debounceTimers[name] = setTimeout(() => {
			// Extract HTML content, excluding the label element
			const clone = regionEl.cloneNode(true);
			const label = clone.querySelector('.dwt-region-label');
			if (label) {
				label.remove();
			}

			const html = clone.innerHTML;

			// Skip if content matches what was last rendered/sent
			if (html === lastRenderedHtml[name]) {
				return;
			}
			lastRenderedHtml[name] = html;

			vscode.postMessage({
				type: 'regionChanged',
				name: name,
				html,
			});
		}, 300);
	}

	// ── Head regions panel ───────────────────────────

	/**
	 * Update the head-regions panel without destroying existing inputs that may
	 * have focus. On first render the panel is built from scratch; on subsequent
	 * renders only the values of unchanged inputs are synced.
	 *
	 * @param {{ name: string; content: string }[]} headRegions
	 */
	function updateHeadRegions(headRegions) {
		if (!headRegions || headRegions.length === 0) {
			headRegionsEl.innerHTML = '';
			return;
		}

		// Check if the panel already exists with the same set of region names
		const existingInputs = /** @type {NodeListOf<HTMLInputElement | HTMLTextAreaElement>} */ (
			headRegionsEl.querySelectorAll('[data-region]')
		);
		const existingNames = Array.from(existingInputs).map((el) => el.getAttribute('data-region'));
		const newNames = headRegions.map((r) => r.name);
		const sameStructure =
			existingNames.length === newNames.length &&
			newNames.every((n, i) => n === existingNames[i]);

		if (sameStructure) {
			// Just update values for inputs that aren't currently focused
			headRegions.forEach((region) => {
				const input = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (
					headRegionsEl.querySelector(`[data-region="${CSS.escape(region.name)}"]`)
				);
				if (input && document.activeElement !== input) {
					input.value = region.content;
				}
			});
			return;
		}

		// Full rebuild (first render or structure changed)
		const details = document.createElement('details');
		details.open = false;

		const summary = document.createElement('summary');
		summary.textContent = 'Head Regions';
		details.appendChild(summary);

		headRegions.forEach((region) => {
			const field = document.createElement('div');
			field.className = 'head-region-field';

			const label = document.createElement('label');
			label.textContent = region.name;

			// Use textarea for multi-line content, input for single-line
			const isMultiline = region.content.includes('\n');
			const input = isMultiline
				? document.createElement('textarea')
				: document.createElement('input');
			if (!isMultiline) {
				/** @type {HTMLInputElement} */ (input).type = 'text';
			}
			input.value = region.content;
			input.setAttribute('data-region', region.name);

			input.addEventListener('input', () => {
				const timerKey = 'head_' + region.name;
				if (debounceTimers[timerKey]) {
					clearTimeout(debounceTimers[timerKey]);
				}
				debounceTimers[timerKey] = setTimeout(() => {
					vscode.postMessage({
						type: 'headRegionChanged',
						name: region.name,
						value: input.value,
					});
				}, 300);
			});

			field.appendChild(label);
			field.appendChild(input);
			details.appendChild(field);
		});

		headRegionsEl.innerHTML = '';
		headRegionsEl.appendChild(details);
	}



	// ── Floating Toolbar ─────────────────────────────

	/** Build the toolbar HTML once and attach all listeners. */
	function setupToolbar() {
		// Inline SVG icons — no external font dependency
		toolbar.innerHTML = `
			<div class="toolbar-group">
				<button class="toolbar-btn" data-command="bold" title="Bold (Ctrl+B)">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M3 2h5.5a3.5 3.5 0 0 1 2.163 6.26A3.5 3.5 0 0 1 8.5 14H3V2zm2 5h3.5a1.5 1.5 0 0 0 0-3H5v3zm0 2v3h3.5a1.5 1.5 0 0 0 0-3H5z"/>
					</svg>
				</button>
				<button class="toolbar-btn" data-command="italic" title="Italic (Ctrl+I)">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M6 2h6v2H9.5l-3 8H9v2H3v-2h2.5l3-8H6V2z"/>
					</svg>
				</button>
				<button class="toolbar-btn" data-command="underline" title="Underline (Ctrl+U)">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M4 2v5.5a4 4 0 0 0 8 0V2h-2v5.5a2 2 0 0 1-4 0V2H4zM2 13h12v1.5H2V13z"/>
					</svg>
				</button>
				<button class="toolbar-btn" data-command="createLink" title="Insert Link">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M6.354 8.354a.5.5 0 0 0 0-.708L4.06 5.354a2.5 2.5 0 1 1 3.536-3.536l2.293 2.293a.5.5 0 0 0 .707-.707L8.303 1.11a3.5 3.5 0 0 0-4.95 4.95l2.293 2.293a.5.5 0 0 0 .708 0zm3.292-.708a.5.5 0 0 0 0 .708l2.293 2.293a2.5 2.5 0 0 1-3.536 3.536L6.11 11.89a.5.5 0 1 0-.707.707l2.293 2.293a3.5 3.5 0 0 0 4.95-4.95l-2.293-2.293a.5.5 0 0 0-.708 0zM5.5 9.5l5-5-.707-.707-5 5 .707.707z"/>
					</svg>
				</button>
			</div>
			<div class="toolbar-group">
				<select class="toolbar-select" id="heading-select">
					<option value="">Paragraph</option>
					<option value="H1">Heading 1</option>
					<option value="H2">Heading 2</option>
					<option value="H3">Heading 3</option>
					<option value="H4">Heading 4</option>
				</select>
			</div>
			<div class="toolbar-group">
				<button class="toolbar-btn" data-command="insertUnorderedList" title="Bulleted List">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M2 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3-1h9v1.5H5V3zm0 4.5h9V9H5V7.5zM2 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3 3h9V13H5v-1.5zm-3 .5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
					</svg>
				</button>
				<button class="toolbar-btn" data-command="insertOrderedList" title="Numbered List">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
						<path d="M1 1h1.5v3H1V1zm2.5 1.5H14V4H3.5V2.5zm0 4.5H14V8.5H3.5V7zm-2.5-.5h1v.5h-.5v.5H2V8H1V7.5zm0 4.5h1.5V13H1v-1.5zM3.5 12H14v1.5H3.5V12z"/>
					</svg>
				</button>
			</div>
		`;

		toolbar.querySelectorAll('.toolbar-btn[data-command]').forEach((btn) => {
			btn.addEventListener('mousedown', (e) => {
				e.preventDefault(); // Prevent focus loss from contenteditable

				const command = btn.getAttribute('data-command');
				if (command === 'createLink') {
					// Save the current selection — showInputBox is async and will
					// clear the selection before the response arrives
					const sel = window.getSelection();
					pendingLinkRange = (sel && sel.rangeCount > 0)
						? sel.getRangeAt(0).cloneRange()
						: null;
					vscode.postMessage({ type: 'requestLinkUrl' });
					// Response handled in the 'linkUrl' message case above
					return;
				}

				applyInlineFormat(command);

				// Trigger change detection for the focused region
				const activeRegion = findActiveRegion();
				if (activeRegion) {
					const name = activeRegion.getAttribute('data-region');
					debounceSendChange(name, activeRegion);
				}
			});
		});

		const headingSelect = document.getElementById('heading-select');
		if (headingSelect) {
			headingSelect.addEventListener('change', (e) => {
				const value = e.target.value;
				applyBlockFormat(value || 'p');

				const activeRegion = findActiveRegion();
				if (activeRegion) {
					const name = activeRegion.getAttribute('data-region');
					debounceSendChange(name, activeRegion);
				}

				headingSelect.value = '';
			});
		}
	}

	// ── Formatting helpers (Selection API) ───────────

	/**
	 * Map toolbar command names to the HTML tag they toggle.
	 * @type {Record<string, string>}
	 */
	const INLINE_TAGS = {
		bold: 'strong',
		italic: 'em',
		underline: 'u',
	};

	/**
	 * Toggle an inline format (bold/italic/underline) on the current selection
	 * using the Selection API, without relying on deprecated execCommand.
	 * @param {string} command - 'bold', 'italic', or 'underline'
	 */
	function applyInlineFormat(command) {
		if (command === 'insertUnorderedList' || command === 'insertOrderedList') {
			applyListFormat(command === 'insertOrderedList' ? 'ol' : 'ul');
			return;
		}

		const tagName = INLINE_TAGS[command];
		if (!tagName) return;

		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

		const range = sel.getRangeAt(0);

		// Check if the entire selection is already wrapped in this tag
		const ancestor = range.commonAncestorContainer;
		const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE
			? /** @type {Element} */ (ancestor)
			: ancestor.parentElement;

		if (ancestorEl && ancestorEl.closest(tagName)) {
			// Unwrap: lift contents out of the wrapping tag
			const wrapper = ancestorEl.closest(tagName);
			const parent = wrapper.parentNode;
			while (wrapper.firstChild) {
				parent.insertBefore(wrapper.firstChild, wrapper);
			}
			parent.removeChild(wrapper);
		} else {
			// Wrap selection in the tag
			const wrapper = document.createElement(tagName);
			try {
				range.surroundContents(wrapper);
			} catch {
				// surroundContents throws if the range partially overlaps an element.
				// Fall back: extract contents, wrap, re-insert.
				const fragment = range.extractContents();
				wrapper.appendChild(fragment);
				range.insertNode(wrapper);
			}
			sel.removeAllRanges();
			const newRange = document.createRange();
			newRange.selectNodeContents(wrapper);
			sel.addRange(newRange);
		}
	}

	/**
	 * Wrap the current selection in a list (ul or ol).
	 * @param {'ul' | 'ol'} listTag
	 */
	function applyListFormat(listTag) {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		const ancestor = range.commonAncestorContainer;
		const block = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement)
			?.closest('p, div, h1, h2, h3, h4, li, dwt-region');

		if (!block) return;

		// If already in a matching list, remove the list wrapping
		const existingList = block.closest(listTag);
		if (existingList) {
			const parent = existingList.parentNode;
			while (existingList.firstChild) {
				const item = existingList.firstChild;
				// Unwrap the li — move its children directly
				if (item.nodeName === 'LI') {
					const p = document.createElement('p');
					while (item.firstChild) p.appendChild(item.firstChild);
					parent.insertBefore(p, existingList);
				} else {
					parent.insertBefore(item, existingList);
				}
			}
			parent.removeChild(existingList);
			return;
		}

		// Wrap the block contents in a list item
		const list = document.createElement(listTag);
		const li = document.createElement('li');
		const fragment = range.cloneContents();
		li.appendChild(fragment);
		list.appendChild(li);
		range.deleteContents();
		range.insertNode(list);
	}

	/**
	 * Replace the block element containing the selection with the given tag.
	 * @param {string} tag - e.g. 'h1', 'h2', 'p'
	 */
	function applyBlockFormat(tag) {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		const ancestor = range.commonAncestorContainer;
		const block = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement)
			?.closest('p, h1, h2, h3, h4, div, li');

		if (!block || block.closest('dwt-region') === null) return;

		const newBlock = document.createElement(tag);
		while (block.firstChild) {
			newBlock.appendChild(block.firstChild);
		}
		block.parentNode.replaceChild(newBlock, block);

		// Restore selection inside the new block
		sel.removeAllRanges();
		const newRange = document.createRange();
		newRange.selectNodeContents(newBlock);
		sel.addRange(newRange);
	}

	/**
	 * Position the floating toolbar above (or below) the given selection range.
	 * Uses visibility:hidden while measuring to avoid a flash at (0,0).
	 * @param {Range} range
	 */
	function positionToolbar(range) {
		const rect = range.getBoundingClientRect();
		// A zero-size rect means the range is not rendered (e.g. detached node)
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			hideToolbar();
			return;
		}

		const margin = 8;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Make visible but transparent while measuring so layout is computed
		toolbar.style.visibility = 'hidden';
		toolbar.classList.add('visible');

		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;

		// Center over selection, clamped horizontally to viewport
		let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
		left = Math.max(margin, Math.min(left, viewportWidth - toolbarWidth - margin));

		// Place above the selection; flip below if too close to top
		let top = rect.top - toolbarHeight - margin;
		if (top < margin) {
			top = rect.bottom + margin;
		}
		// Clamp bottom edge too
		top = Math.min(top, viewportHeight - toolbarHeight - margin);

		toolbar.style.left = left + 'px';
		toolbar.style.top = top + 'px';
		toolbar.style.visibility = '';
	}

	function hideToolbar() {
		toolbar.classList.remove('visible');
		toolbar.style.visibility = '';
	}

	/** @returns {Element|null} */
	function findActiveRegion() {
		// Check if the current selection is inside a dwt-region
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const node = sel.anchorNode;
			if (node) {
				const el = node.nodeType === Node.ELEMENT_NODE
					? /** @type {Element} */ (node)
					: node.parentElement;
				if (el) {
					return el.closest('dwt-region');
				}
			}
		}
		// Fallback to the active-class region
		return container.querySelector('dwt-region.dwt-region--active');
	}

	// ── Region indicator ─────────────────────────────

	/**
	 * @param {string} name
	 */
	function showRegionIndicator(name) {
		regionIndicator.textContent = name;
		regionIndicator.classList.add('visible');
	}

	function hideRegionIndicator() {
		regionIndicator.classList.remove('visible');
	}
})();
