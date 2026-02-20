import * as vscode from 'vscode';
import { findInstanceFiles } from '../template/templateUpdater';

type TreeItem = TemplateTreeItem | InstanceTreeItem;

class TemplateTreeItem extends vscode.TreeItem {
	readonly templateUri: vscode.Uri;

	constructor(uri: vscode.Uri) {
		const label = vscode.workspace.asRelativePath(uri, false);
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
		this.templateUri = uri;
		this.resourceUri = uri;
		this.iconPath = new vscode.ThemeIcon('file-code');
		this.contextValue = 'dwtTemplate';
		this.command = {
			command: 'vscode.open',
			title: 'Open Template',
			arguments: [uri],
		};
	}
}

class InstanceTreeItem extends vscode.TreeItem {
	constructor(uri: vscode.Uri) {
		const label = vscode.workspace.asRelativePath(uri, false);
		super(label, vscode.TreeItemCollapsibleState.None);
		this.resourceUri = uri;
		this.iconPath = new vscode.ThemeIcon('file');
		this.contextValue = 'dwtInstance';
		this.command = {
			command: 'vscode.open',
			title: 'Open File',
			arguments: [uri],
		};
	}
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TreeItem): Promise<TreeItem[]> {
		if (!element) {
			// Root: list all .dwt files
			const dwtFiles = await vscode.workspace.findFiles(
				'**/*.dwt',
				'**/node_modules/**',
				500,
			);
			return dwtFiles
				.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
				.map((uri) => new TemplateTreeItem(uri));
		}

		if (element instanceof TemplateTreeItem) {
			const instances = await findInstanceFiles(element.templateUri);
			return instances
				.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath))
				.map(({ uri }) => new InstanceTreeItem(uri));
		}

		return [];
	}
}
