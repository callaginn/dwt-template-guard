(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	let allFiles = [];
	let templateData = null;
	let selectedIndices = new Set();
	let lastClickedIndex = -1;

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'init') {
			allFiles = message.files;
			templateData = message.templateData;
			render();
		}
	});

	function render() {
		let html = `
			<div class="modal-container">
				<div class="modal-header">
					<i class="codicon codicon-files"></i>
					<h2>Do you want to update all files based on this template?</h2>
				</div>
				<p class="modal-subtitle">
					${allFiles.length} file${allFiles.length !== 1 ? 's' : ''} found.
					Click to select individual files, or hold <kbd>Shift</kbd> to select a range.
					If none are selected, all files will be updated.
				</p>
				<ul class="file-list" id="file-list">`;

		for (let i = 0; i < allFiles.length; i++) {
			const file = allFiles[i];
			const isSelected = selectedIndices.has(i);
			html += `
				<li class="file-item${isSelected ? ' selected' : ''}" data-index="${i}">
					<i class="codicon ${isSelected ? 'codicon-check' : 'codicon-file'}"></i>
					<span class="file-path">${escapeHtml(file.relativePath)}</span>
				</li>`;
		}

		html += `
				</ul>
				<div class="modal-actions">
					<span class="selection-count" id="selection-count"></span>
					<button class="btn btn-secondary" id="btn-cancel">Don't Update</button>
					<button class="btn btn-primary" id="btn-update">
						<i class="codicon codicon-sync"></i> Update
					</button>
				</div>
			</div>`;

		root.innerHTML = html;
		updateSelectionCount();
		attachListeners();
	}

	function attachListeners() {
		const items = root.querySelectorAll('.file-item');
		items.forEach((item) => {
			item.addEventListener('click', (e) => {
				const index = parseInt(item.getAttribute('data-index'), 10);

				if (e.shiftKey && lastClickedIndex >= 0) {
					// Shift-click: select the range
					const start = Math.min(lastClickedIndex, index);
					const end = Math.max(lastClickedIndex, index);
					for (let i = start; i <= end; i++) {
						selectedIndices.add(i);
					}
				} else {
					// Toggle single item
					if (selectedIndices.has(index)) {
						selectedIndices.delete(index);
					} else {
						selectedIndices.add(index);
					}
				}

				lastClickedIndex = index;
				updateFileListUI();
				updateSelectionCount();
			});
		});

		document.getElementById('btn-update').addEventListener('click', () => {
			let filesToUpdate;
			if (selectedIndices.size === 0) {
				filesToUpdate = allFiles.map((f) => ({ uri: f.uri, templatePath: f.templatePath }));
			} else {
				filesToUpdate = Array.from(selectedIndices)
					.sort((a, b) => a - b)
					.map((i) => ({ uri: allFiles[i].uri, templatePath: allFiles[i].templatePath }));
			}

			vscode.postMessage({
				type: 'update',
				selectedFiles: filesToUpdate,
				templateData: templateData,
			});
		});

		document.getElementById('btn-cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'cancel' });
		});
	}

	function updateFileListUI() {
		root.querySelectorAll('.file-item').forEach((item) => {
			const index = parseInt(item.getAttribute('data-index'), 10);
			const isSelected = selectedIndices.has(index);
			item.classList.toggle('selected', isSelected);
			const icon = item.querySelector('.codicon');
			if (icon) {
				icon.className = 'codicon ' + (isSelected ? 'codicon-check' : 'codicon-file');
			}
		});
	}

	function updateSelectionCount() {
		const el = document.getElementById('selection-count');
		if (!el) return;
		if (selectedIndices.size === 0) {
			el.textContent = 'All ' + allFiles.length + ' files will be updated';
		} else {
			el.textContent = selectedIndices.size + ' of ' + allFiles.length + ' selected';
		}
	}

	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
})();
