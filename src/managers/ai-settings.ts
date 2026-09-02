// Settings page section for the AI seam: endpoint (OpenAI-style base URL + key +
// model), a live connection test, and the immersive-translation options Reader
// reads at runtime.

import { generalSettings, saveSettings } from '../utils/storage-utils';
import type { AiSettings } from '../types/types';
import { LANGUAGE_OPTIONS } from '../utils/ai/translate';
import { maskAiSecrets, normalizeAiBaseUrl, parseAiExtraParams } from '../utils/ai/chat';
import { isLocalEndpoint } from '../utils/ai/config';
import { requestAiTest } from '../utils/ai/messenger';
import { getMessage } from '../utils/i18n';
import { initializeSettingToggle } from '../utils/ui-utils';
import { debounce } from '../utils/debounce';
import { initializeIcons } from '../icons/icons';

const CUSTOM_LANGUAGE = '__custom__';

export async function initializeAiSettings(): Promise<void> {
	const form = document.getElementById('ai-settings-form');
	if (!form) return;

	initializeIcons();

	initializeSettingToggle('ai-enabled-toggle', generalSettings.ai.enabled, (checked) => {
		setAiSetting('enabled', checked);
	});

	initializeEndpointFields();
	initializeTestButton();
	await initializeLanguageField();
	initializeTranslationControls();

	const debouncedSavePrompt = debounce(() => savePrompt(), 500);
	form.addEventListener('input', (event) => {
		if ((event.target as HTMLElement).id === 'ai-translate-prompt') {
			debouncedSavePrompt();
		}
	});
}

async function setAiSetting<K extends keyof AiSettings>(key: K, value: AiSettings[K]): Promise<void> {
	await saveSettings({ ...generalSettings, ai: { ...generalSettings.ai, [key]: value } });
}

function currentDraft(): AiSettings {
	return { ...generalSettings.ai };
}

function initializeEndpointFields(): void {
	const baseUrl = document.getElementById('ai-base-url') as HTMLInputElement;
	if (baseUrl) {
		baseUrl.value = generalSettings.ai.baseUrl;
		baseUrl.addEventListener('change', () => {
			const value = baseUrl.value.trim();
			if (!value) {
				setAiSetting('baseUrl', '');
				return;
			}
			try {
				const normalized = normalizeAiBaseUrl(value);
				baseUrl.value = normalized;
				setAiSetting('baseUrl', normalized);
				hideStatus();
			} catch (error) {
				showStatus('error', error instanceof Error ? error.message : String(error));
			}
		});
	}

	const apiKey = document.getElementById('ai-api-key') as HTMLInputElement;
	if (apiKey) {
		apiKey.value = generalSettings.ai.apiKey;
		apiKey.addEventListener('change', () => {
			setAiSetting('apiKey', apiKey.value.trim());
		});
	}

	const model = document.getElementById('ai-model') as HTMLInputElement;
	if (model) {
		model.value = generalSettings.ai.model;
		model.addEventListener('change', () => {
			setAiSetting('model', model.value.trim());
			hideStatus();
		});
	}

	const extraParams = document.getElementById('ai-extra-params') as HTMLTextAreaElement;
	if (extraParams) {
		extraParams.value = generalSettings.ai.extraParams || '';
		extraParams.addEventListener('change', () => {
			const value = extraParams.value.trim();
			extraParams.value = value;
			try {
				parseAiExtraParams(value);
			} catch (error) {
				// Keep the text: the user is mid-edit, and the status line says what
				// is wrong with it.
				showStatus('error', error instanceof Error ? error.message : String(error));
				return;
			}
			setAiSetting('extraParams', value);
			hideStatus();
		});
	}
}

function readDraftEndpoint(): { baseUrl: string; apiKey: string; model: string; extraParams: string } {
	const baseUrl = document.getElementById('ai-base-url') as HTMLInputElement | null;
	const apiKey = document.getElementById('ai-api-key') as HTMLInputElement | null;
	const model = document.getElementById('ai-model') as HTMLInputElement | null;
	const extraParams = document.getElementById('ai-extra-params') as HTMLTextAreaElement | null;

	return {
		baseUrl: (baseUrl?.value || generalSettings.ai.baseUrl).trim(),
		apiKey: (apiKey?.value || generalSettings.ai.apiKey).trim(),
		model: (model?.value || generalSettings.ai.model).trim(),
		extraParams: (extraParams?.value ?? generalSettings.ai.extraParams).trim()
	};
}

async function testConnection(): Promise<void> {
	const btn = document.getElementById('ai-test-btn') as HTMLButtonElement | null;
	const draft = readDraftEndpoint();

	let baseUrl: string;
	try {
		baseUrl = normalizeAiBaseUrl(draft.baseUrl);
	} catch (error) {
		showStatus('error', error instanceof Error ? error.message : String(error));
		return;
	}
	const urlInput = document.getElementById('ai-base-url') as HTMLInputElement | null;
	if (urlInput) urlInput.value = baseUrl;

	if (!draft.model) {
		showStatus('error', getMessage('aiMissingModel') || 'Set a model name first.');
		return;
	}
	if (!draft.apiKey && !isLocalEndpoint(baseUrl)) {
		showStatus('error', getMessage('aiMissingApiKey') || 'Set an API key first.');
		return;
	}
	// Malformed extras would fail at the endpoint with a message that does not
	// point back at the field, so check them here where we can name the field.
	try {
		parseAiExtraParams(draft.extraParams);
	} catch (error) {
		showStatus('error', error instanceof Error ? error.message : String(error));
		return;
	}

	const originalLabel = btn?.textContent || '';
	if (btn) {
		btn.disabled = true;
		btn.textContent = getMessage('aiTestingConnection') || 'Testing…';
	}
	showStatus('info', getMessage('aiTestingConnection') || 'Testing…');

	try {
		const reply = await requestAiTest({
			baseUrl,
			apiKey: draft.apiKey,
			model: draft.model,
			extraParams: draft.extraParams
		});
		await saveSettings({
			...generalSettings,
			ai: {
				...generalSettings.ai,
				baseUrl,
				apiKey: draft.apiKey,
				model: draft.model,
				extraParams: draft.extraParams
			}
		});
		showStatus('success', getMessage('aiTestSuccess', maskAiSecrets(reply, draft.apiKey)));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		showStatus('error', maskAiSecrets(message, draft.apiKey));
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = originalLabel || getMessage('aiTestConnection');
		}
	}
}

function initializeTestButton(): void {
	const btn = document.getElementById('ai-test-btn');
	if (btn) btn.addEventListener('click', () => { void testConnection(); });
}

async function initializeLanguageField(): Promise<void> {
	const select = document.getElementById('ai-target-lang') as HTMLSelectElement | null;
	const custom = document.getElementById('ai-target-lang-custom') as HTMLInputElement | null;
	if (!select) return;

	select.textContent = '';
	for (const option of LANGUAGE_OPTIONS) {
		const element = document.createElement('option');
		element.value = option.code;
		element.textContent = option.label;
		select.appendChild(element);
	}
	const customOption = document.createElement('option');
	customOption.value = CUSTOM_LANGUAGE;
	customOption.textContent = getMessage('aiCustomLanguage') || 'Custom code…';
	select.appendChild(customOption);

	const known = LANGUAGE_OPTIONS.some(option => option.code === generalSettings.ai.targetLang);
	const useCustom = !known;
	select.value = useCustom ? CUSTOM_LANGUAGE : generalSettings.ai.targetLang;

	const applyCustom = (value: string) => {
		if (!custom) return;
		const code = value.trim();
		if (!code) return;
		setAiSetting('targetLang', code);
		hideStatus();
	};

	if (custom) {
		custom.value = useCustom ? generalSettings.ai.targetLang : '';
		custom.classList.toggle('is-hidden', !useCustom);
		custom.addEventListener('input', debounce(() => applyCustom(custom.value), 400));
		custom.addEventListener('change', () => applyCustom(custom.value));
	}

	select.addEventListener('change', () => {
		if (select.value === CUSTOM_LANGUAGE) {
			custom?.classList.remove('is-hidden');
			custom?.focus();
			if (custom?.value.trim()) applyCustom(custom.value);
			return;
		}
		custom?.classList.add('is-hidden');
		setAiSetting('targetLang', select.value);
	});
}

function initializeTranslationControls(): void {
	const draft = currentDraft();

	const mode = document.getElementById('ai-translate-mode') as HTMLSelectElement | null;
	if (mode) {
		mode.value = draft.mode;
		mode.addEventListener('change', () => {
			setAiSetting('mode', mode.value === 'replacement' ? 'replacement' : 'bilingual');
		});
	}

	initializeSettingToggle('ai-translate-transcript', draft.translateTranscript, (checked) => {
		setAiSetting('translateTranscript', checked);
	});

	initializeSettingToggle('ai-auto-translate', draft.autoTranslate, (checked) => {
		setAiSetting('autoTranslate', checked);
	});

	const prompt = document.getElementById('ai-translate-prompt') as HTMLTextAreaElement | null;
	if (prompt) prompt.value = draft.prompt;

	const reset = document.getElementById('ai-reset-prompt-btn');
	if (reset) {
		reset.addEventListener('click', () => {
			if (prompt) prompt.value = '';
			setAiSetting('prompt', '');
			showStatus('info', getMessage('aiPromptReset') || 'Translation prompt reset to the built-in default.');
		});
	}
}

function savePrompt(): void {
	const prompt = document.getElementById('ai-translate-prompt') as HTMLTextAreaElement | null;
	if (!prompt) return;
	setAiSetting('prompt', prompt.value);
}

function getStatusElement(): HTMLElement | null {
	return document.getElementById('ai-status');
}

function showStatus(kind: 'success' | 'error' | 'info', text: string): void {
	const element = getStatusElement();
	if (!element) return;

	element.textContent = text;
	element.classList.remove('is-success', 'is-error', 'is-info');
	element.classList.add(`is-${kind}`);
	element.style.display = '';
}

function hideStatus(): void {
	const element = getStatusElement();
	if (!element) return;
	element.textContent = '';
	element.style.display = 'none';
}
