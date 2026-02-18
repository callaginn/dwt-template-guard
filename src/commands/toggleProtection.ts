import * as vscode from 'vscode';

export async function toggleProtection(
	statusBarItem: vscode.StatusBarItem,
): Promise<void> {
	const config = vscode.workspace.getConfiguration('dwtTemplateGuard');
	const current = config.get<boolean>('enableProtection', true);
	const newValue = !current;

	await config.update(
		'enableProtection',
		newValue,
		vscode.ConfigurationTarget.Workspace,
	);

	updateStatusBar(statusBarItem, newValue);

	vscode.window.showInformationMessage(
		`Template protection ${newValue ? 'enabled' : 'disabled'} for this workspace.`,
	);
}

export function updateStatusBar(
	item: vscode.StatusBarItem,
	enabled: boolean,
): void {
	item.text = enabled ? '$(lock) DWT Protected' : '$(unlock) DWT Unprotected';
	item.tooltip = enabled
		? 'Template protection is active. Click to disable.'
		: 'Template protection is disabled. Click to enable.';
	item.command = 'dwtTemplateGuard.toggleProtection';
	item.show();
}
