(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	/** Current list of available templates (populated by extension). */
	let availableTemplates = [];

	window.addEventListener('message', (event) => {
		const message = event.data;

		switch (message.type) {
			case 'clear':
				root.innerHTML =
					'<p class="empty-state">Open a Dreamweaver template instance to see properties.</p>';
				break;

			case 'update':
				render(message.params, message.templatePath, message.editableRegions);
				break;

			case 'templates':
				availableTemplates = message.templates || [];
				updateTemplateDropdown();
				break;

			case 'copied':
				showCopiedFeedback(message.regionName, message.format);
				break;
		}
	});

	// Ask the extension for the template list on load
	vscode.postMessage({ type: 'requestTemplates' });

	function render(params, templatePath, editableRegions) {
		let html = '';

		// Template selector + actions
		html += `
			<div class="template-section">
				<div class="section-label">Template</div>
				<select class="template-select" id="template-select">
					<option value="">${templatePath ? escapeHtml(templatePath) : 'None'}</option>
				</select>
				<div class="template-actions">
					<button class="action-btn" data-action="openTemplate" title="Open the .dwt template file"><i class="codicon codicon-go-to-file"></i> Open</button>
					<button class="action-btn" data-action="updatePage" title="Re-apply template to this page"><i class="codicon codicon-refresh"></i> Update</button>
					<button class="action-btn action-btn--danger" data-action="detachTemplate" title="Remove all template markers"><i class="codicon codicon-debug-disconnect"></i> Detach</button>
				</div>
			</div>`;

		// Instance parameters
		if (params && params.length > 0) {
			html += '<div class="section-header">Parameters</div>';
			for (const param of params) {
				html += renderParam(param);
			}
		}

		// Editable regions list
		if (editableRegions && editableRegions.length > 0) {
			html += '<div class="section-header">Editable Regions</div>';
			html += '<ul class="regions-list">';
			for (const name of editableRegions) {
				const eName = escapeHtml(name);
				html += `
					<li class="region-item">
						<span class="region-name" data-region="${eName}" title="Jump to region">${eName}</span>
						<button class="region-btn" data-copy-md="${eName}" title="Copy as Markdown"><i class="codicon codicon-markdown"></i></button>
						<button class="region-btn" data-copy-region="${eName}" title="Copy as HTML"><i class="codicon codicon-copy"></i></button>
					</li>`;
			}
			html += '</ul>';
			html += `
				<div class="export-actions">
					<button class="action-btn" data-action="exportAllHtml"><i class="codicon codicon-file-code"></i> Export All HTML</button>
					<button class="action-btn" data-action="exportAllMarkdown"><i class="codicon codicon-markdown"></i> Export All Markdown</button>
				</div>`;
		}

		if (!html) {
			html = '<p class="empty-state">No template properties found in this file.</p>';
		}

		root.innerHTML = html;
		attachListeners();
		updateTemplateDropdown();
	}

	function renderParam(param) {
		const name = escapeHtml(param.name);
		const type = escapeHtml(param.type);

		if (param.type === 'boolean') {
			const checked = param.value === 'true';
			return `
				<div class="toggle-row">
					<label class="toggle-switch">
						<input type="checkbox" class="param-input"
							data-name="${name}"
							${checked ? 'checked' : ''}>
						<span class="toggle-track"></span>
					</label>
					<span class="toggle-label" data-toggle-for="${name}">${name}</span>
					<button class="param-copy-btn" data-copy-param="${name}" title="Copy value"><i class="codicon codicon-copy"></i></button>
				</div>`;
		}

		const value = escapeHtml(param.value);
		let inputHtml;

		switch (param.type) {
			case 'color':
				inputHtml = `
					<div class="color-field">
						<div class="color-swatch">
							<input type="color" class="param-input" data-name="${name}" value="${value}">
						</div>
						<input type="text" class="color-hex param-input" data-name="${name}" value="${value}" spellcheck="false">
					</div>`;
				break;
			case 'URL':
				inputHtml = `<input type="url" class="param-input" data-name="${name}" value="${value}" placeholder="https://...">`;
				break;
			case 'number':
				inputHtml = `<input type="number" class="param-input" data-name="${name}" value="${value}">`;
				break;
			default:
				inputHtml = `<input type="text" class="param-input" data-name="${name}" value="${value}">`;
				break;
		}

		return `
			<div class="param-row">
				<label class="param-label">${name}</label>
				${inputHtml}
			</div>`;
	}

	function attachListeners() {
		// Param inputs (non-color)
		root.querySelectorAll('.param-input').forEach((input) => {
			// Skip color swatch inputs — handled separately
			if (input.type === 'color') return;

			input.addEventListener('change', (e) => {
				const el = e.target;
				const name = el.getAttribute('data-name');
				const value = el.type === 'checkbox'
					? (el.checked ? 'true' : 'false')
					: el.value;

				// Sync color swatch <-> hex input
				if (el.classList.contains('color-hex')) {
					const swatch = el.parentElement.querySelector('input[type="color"]');
					if (swatch && isValidColor(el.value)) {
						swatch.value = el.value;
					}
				}

				vscode.postMessage({ type: 'updateParam', name, value });
			});
		});

		// Color swatch inputs
		root.querySelectorAll('input[type="color"].param-input').forEach((input) => {
			input.addEventListener('input', (e) => {
				const el = e.target;
				const hexInput = el.closest('.color-field')?.querySelector('.color-hex');
				if (hexInput) {
					hexInput.value = el.value;
				}
			});
			input.addEventListener('change', (e) => {
				const el = e.target;
				const name = el.getAttribute('data-name');
				const hexInput = el.closest('.color-field')?.querySelector('.color-hex');
				if (hexInput) {
					hexInput.value = el.value;
				}
				vscode.postMessage({ type: 'updateParam', name, value: el.value });
			});
		});

		// Jump to editable region
		root.querySelectorAll('.region-name').forEach((el) => {
			el.addEventListener('click', () => {
				vscode.postMessage({
					type: 'jumpToRegion',
					regionName: el.getAttribute('data-region'),
				});
			});
		});

		// Copy editable region as HTML
		root.querySelectorAll('.region-btn[data-copy-region]').forEach((btn) => {
			btn.addEventListener('click', () => {
				vscode.postMessage({
					type: 'copyRegion',
					regionName: btn.getAttribute('data-copy-region'),
				});
			});
		});

		// Copy editable region as Markdown
		root.querySelectorAll('.region-btn[data-copy-md]').forEach((btn) => {
			btn.addEventListener('click', () => {
				vscode.postMessage({
					type: 'copyRegionMarkdown',
					regionName: btn.getAttribute('data-copy-md'),
				});
			});
		});

		// Template selector
		const select = document.getElementById('template-select');
		if (select) {
			select.addEventListener('change', () => {
				if (select.value) {
					vscode.postMessage({
						type: 'changeTemplate',
						templatePath: select.value,
					});
				}
			});
		}

		// Action buttons (openTemplate, updatePage, detachTemplate, exportAllHtml, exportAllMarkdown)
		root.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
			btn.addEventListener('click', () => {
				vscode.postMessage({ type: btn.getAttribute('data-action') });
			});
		});

		// Toggle label clicks
		root.querySelectorAll('.toggle-label[data-toggle-for]').forEach((label) => {
			label.addEventListener('click', () => {
				const name = label.getAttribute('data-toggle-for');
				const checkbox = root.querySelector(`.param-input[data-name="${CSS.escape(name)}"]`);
				if (checkbox && checkbox.type === 'checkbox') {
					checkbox.checked = !checkbox.checked;
					checkbox.dispatchEvent(new Event('change'));
				}
			});
		});

		// Copy param value buttons
		root.querySelectorAll('.param-copy-btn[data-copy-param]').forEach((btn) => {
			btn.addEventListener('click', () => {
				const name = btn.getAttribute('data-copy-param');
				const input = root.querySelector(`.param-input[data-name="${CSS.escape(name)}"]`);
				if (!input) return;

				const value = input.type === 'checkbox' ? (input.checked ? 'true' : 'false') : input.value;
				navigator.clipboard.writeText(value).then(() => {
					const original = btn.innerHTML;
					btn.classList.add('copied');
					btn.innerHTML = '<i class="codicon codicon-check"></i>';
					setTimeout(() => {
						btn.classList.remove('copied');
						btn.innerHTML = original;
					}, 1200);
				});
			});
		});
	}

	function updateTemplateDropdown() {
		const select = document.getElementById('template-select');
		if (!select) return;

		// Keep the first option (current) and add available templates
		const currentValue = select.options[0]
			? select.options[0].textContent
			: '';

		// Rebuild options
		while (select.options.length > 1) {
			select.remove(1);
		}

		for (const tpl of availableTemplates) {
			// Skip if it's the current template
			if (tpl === currentValue) continue;
			const opt = document.createElement('option');
			opt.value = tpl;
			opt.textContent = tpl;
			select.appendChild(opt);
		}
	}

	function showCopiedFeedback(regionName, format) {
		const selector = format === 'markdown'
			? `.region-btn[data-copy-md="${CSS.escape(regionName)}"]`
			: `.region-btn[data-copy-region="${CSS.escape(regionName)}"]`;
		const btn = root.querySelector(selector);
		if (!btn) return;
		btn.classList.add('copied');
		const original = btn.innerHTML;
		btn.innerHTML = '<i class="codicon codicon-check"></i>';
		setTimeout(() => {
			btn.classList.remove('copied');
			btn.innerHTML = original;
		}, 1200);
	}

	function isValidColor(str) {
		return /^#[0-9a-fA-F]{3,8}$/.test(str);
	}

	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
})();
