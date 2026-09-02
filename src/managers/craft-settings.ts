// Settings page section for the Craft destination: enable toggle, Space API
// link (with a live connection test), default folder picker and document
// format options.

import { generalSettings, saveSettings } from '../utils/storage-utils';
import { CraftSettings } from '../types/types';
import { normalizeApiUrl, toCraftErrorMessage } from '../utils/craft/api';
import { craftTestConnection } from '../utils/craft/client';
import {
	loadCraftFolders,
	buildCraftFolderOptions,
	clearCachedFolderTree,
	coerceCraftFolderId,
	CraftFolderOption,
	UNSORTED_FOLDER_ID
} from '../utils/craft/folders';
import { getMessage } from '../utils/i18n';
import { initializeSettingToggle } from '../utils/ui-utils';
import { debounce } from '../utils/debounce';
import { initializeIcons } from '../icons/icons';

export async function initializeCraftSettings(): Promise<void> {
	const form = document.getElementById('craft-settings-form');
	if (!form) return;

	initializeSettingToggle('craft-enabled-toggle', generalSettings.craft.enabled, (checked) => {
		saveSettings({ ...generalSettings, craft: { ...generalSettings.craft, enabled: checked } });
	});

	initializeApiUrlField();
	initializeFolderControls();
	initializeFormatControls();

	const debouncedSaveTextFields = debounce(() => saveTextFields(), 500);
	form.addEventListener('input', (event) => {
		const target = event.target as HTMLElement;
		if (target.id === 'craft-header-format' || target.id === 'craft-tags') {
			debouncedSaveTextFields();
		}
	});

	await loadFolderOptions(false);
}

async function setCraftSetting<K extends keyof CraftSettings>(
	key: K,
	value: CraftSettings[K]
): Promise<void> {
	await saveSettings({ ...generalSettings, craft: { ...generalSettings.craft, [key]: value } });
}

function saveTextFields(): void {
	const headerFormat = document.getElementById('craft-header-format') as HTMLTextAreaElement;
	const tags = document.getElementById('craft-tags') as HTMLInputElement;

	saveSettings({
		...generalSettings,
		craft: {
			...generalSettings.craft,
			headerFormat: headerFormat ? headerFormat.value : generalSettings.craft.headerFormat,
			tags: tags ? tags.value : generalSettings.craft.tags
		}
	});
}

function initializeApiUrlField(): void {
	const input = document.getElementById('craft-api-url') as HTMLInputElement;
	if (input) {
		input.value = generalSettings.craft.apiUrl;

		// Normalize and persist whatever the user pasted (full link, share link
		// or bare id) once they leave the field.
		input.addEventListener('change', () => {
			if (!input.value.trim()) {
				if (generalSettings.craft.apiUrl) {
					setCraftSetting('apiUrl', '');
					showCraftStatus('info', getMessage('craftApiLinkCleared'));
				}
				return;
			}
			try {
				const apiUrl = normalizeApiUrl(input.value);
				input.value = apiUrl;
				setCraftSetting('apiUrl', apiUrl);
				hideCraftStatus();
			} catch (error) {
				showCraftStatus('error', toCraftErrorMessage(error));
			}
		});
	}

	const testBtn = document.getElementById('craft-test-connection-btn');
	if (testBtn) {
		testBtn.addEventListener('click', () => testConnection());
	}
}

async function testConnection(): Promise<void> {
	const input = document.getElementById('craft-api-url') as HTMLInputElement;
	const btn = document.getElementById('craft-test-connection-btn') as HTMLButtonElement;
	if (!input) return;

	let apiUrl: string;
	try {
		apiUrl = normalizeApiUrl(input.value);
	} catch (error) {
		showCraftStatus('error', toCraftErrorMessage(error));
		return;
	}
	input.value = apiUrl;

	const originalLabel = btn ? btn.textContent || '' : '';
	if (btn) {
		btn.disabled = true;
		btn.textContent = getMessage('craftTestingConnection');
	}
	showCraftStatus('info', getMessage('craftTestingConnection'));

	try {
		const connection = await craftTestConnection(apiUrl);
		await setCraftSetting('apiUrl', apiUrl);
		const spaceName = connection?.space?.name || getMessage('craftUnnamedSpace');
		showCraftStatus('success', getMessage('craftConnected', spaceName));
		await loadFolderOptions(true);
	} catch (error) {
		showCraftStatus('error', toCraftErrorMessage(error));
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = originalLabel || getMessage('craftTestConnection');
		}
	}
}

function initializeFolderControls(): void {
	const select = document.getElementById('craft-default-folder') as HTMLSelectElement;
	if (select) {
		renderFolderOptions(select, [{ id: UNSORTED_FOLDER_ID, label: getMessage('craftFolderUnsorted') }]);
		select.value = coerceCraftFolderId(generalSettings.craft.defaultFolderId, [
			{ id: UNSORTED_FOLDER_ID, label: '' }
		]);
		select.addEventListener('change', () => {
			setCraftSetting('defaultFolderId', select.value);
		});
	}

	const refreshBtn = document.getElementById('craft-refresh-folders-btn');
	if (refreshBtn) {
		refreshBtn.addEventListener('click', async () => {
			await clearCachedFolderTree();
			await loadFolderOptions(true);
		});
	}

	initializeIcons();
}

async function loadFolderOptions(forceRefresh: boolean): Promise<void> {
	const select = document.getElementById('craft-default-folder') as HTMLSelectElement;
	if (!select) return;

	const unsortedLabel = getMessage('craftFolderUnsorted');
	const unsortedOnly: CraftFolderOption[] = [{ id: UNSORTED_FOLDER_ID, label: unsortedLabel }];

	if (!generalSettings.craft.apiUrl) {
		renderFolderOptions(select, unsortedOnly);
		return;
	}

	select.disabled = true;
	try {
		const folders = await loadCraftFolders(forceRefresh);
		const options = buildCraftFolderOptions(folders, unsortedLabel);
		renderFolderOptions(select, options);

		const coerced = coerceCraftFolderId(generalSettings.craft.defaultFolderId, options);
		select.value = coerced;
		if (coerced !== generalSettings.craft.defaultFolderId) {
			await setCraftSetting('defaultFolderId', coerced);
		}
	} catch (error) {
		renderFolderOptions(select, unsortedOnly);
		showCraftStatus('error', toCraftErrorMessage(error));
	} finally {
		select.disabled = false;
	}
}

function renderFolderOptions(select: HTMLSelectElement, options: CraftFolderOption[]): void {
	const previous = select.value;
	select.textContent = '';

	for (const option of options) {
		const element = document.createElement('option');
		element.value = option.id;
		element.textContent = option.label;
		select.appendChild(element);
	}

	if (options.some(option => option.id === previous)) {
		select.value = previous;
	}
}

function initializeFormatControls(): void {
	const headerFormat = document.getElementById('craft-header-format') as HTMLTextAreaElement;
	if (headerFormat) {
		headerFormat.value = generalSettings.craft.headerFormat;
	}

	const tags = document.getElementById('craft-tags') as HTMLInputElement;
	if (tags) {
		tags.value = generalSettings.craft.tags;
	}

	initializeFormatDropdown('craft-properties-as', 'propertiesAs');
	initializeFormatDropdown('craft-wikilinks', 'wikilinks');
}

function initializeFormatDropdown<K extends keyof CraftSettings>(
	elementId: string,
	key: K
): void {
	const dropdown = document.getElementById(elementId) as HTMLSelectElement;
	if (!dropdown) return;

	dropdown.value = String(generalSettings.craft[key]);
	dropdown.addEventListener('change', () => {
		setCraftSetting(key, dropdown.value as CraftSettings[K]);
	});
}

function getCraftStatusElement(): HTMLElement | null {
	return document.getElementById('craft-connection-status');
}

function showCraftStatus(kind: 'success' | 'error' | 'info', text: string): void {
	const element = getCraftStatusElement();
	if (!element) return;

	element.textContent = text;
	element.classList.remove('is-success', 'is-error', 'is-info');
	element.classList.add(`is-${kind}`);
	element.style.display = '';
}

function hideCraftStatus(): void {
	const element = getCraftStatusElement();
	if (!element) return;
	element.textContent = '';
	element.style.display = 'none';
}
