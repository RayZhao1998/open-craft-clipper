// Settings page section for the AI seam: endpoint (OpenAI-style base URL + key +
// model), a live connection test, and the immersive-translation options Reader
// reads at runtime.

import { generalSettings, saveSettings } from '../utils/storage-utils';
import type { AiSettings } from '../types/types';
import { LANGUAGE_OPTIONS } from '../utils/ai/translate';
import { maskAiSecrets, normalizeAiBaseUrl, parseAiExtraParams } from '../utils/ai/chat';
import { isLocalEndpoint } from '../utils/ai/config';
import { requestAiTest, requestAiUsage, requestAiUsageClear } from '../utils/ai/messenger';
import type { AiUsagePanelData } from '../utils/ai/messenger';
import type { AiUsageSummary } from '../utils/ai/usage';
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
	void initializeUsagePanel();

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

// --- Usage -----------------------------------------------------------------
// The numbers are folded in the background (see utils/ai/usage.ts); this only
// asks for one window and draws it. Nothing here holds the log itself.

async function initializeUsagePanel(): Promise<void> {
	const toggle = document.getElementById('ai-record-usage') as HTMLInputElement | null;
	if (toggle) {
		initializeSettingToggle('ai-record-usage', generalSettings.ai.recordUsage !== false, async (checked) => {
			await setAiSetting('recordUsage', checked);
			if (!checked) {
				// "Keep nothing" means the log goes with it — a stale list under an
				// off switch would be the worst of both.
				try {
					await requestAiUsageClear();
				} catch { /* the list is off either way */ }
			}
			await refreshUsage();
		});
	}

	const windowSelect = document.getElementById('ai-usage-window') as HTMLSelectElement | null;
	if (windowSelect) {
		windowSelect.addEventListener('change', () => { void refreshUsage(); });
	}

	const savePrices = debounce(() => {
		const input = document.getElementById('ai-price-input') as HTMLInputElement | null;
		const output = document.getElementById('ai-price-output') as HTMLInputElement | null;
		void Promise.all([
			setAiSetting('priceInput', (input?.value || '').trim()),
			setAiSetting('priceOutput', (output?.value || '').trim())
		]).then(() => refreshUsage());
	}, 500);

	for (const id of ['ai-price-input', 'ai-price-output']) {
		const field = document.getElementById(id) as HTMLInputElement | null;
		if (!field) continue;
		field.value = id === 'ai-price-input' ? generalSettings.ai.priceInput : generalSettings.ai.priceOutput;
		field.addEventListener('input', savePrices);
	}

	const clear = document.getElementById('ai-usage-clear');
	if (clear) {
		clear.addEventListener('click', async () => {
			try {
				await requestAiUsageClear();
			} catch (error: unknown) {
				showStatus('error', error instanceof Error ? error.message : String(error));
			}
			await refreshUsage();
		});
	}

	await refreshUsage();
}

function usageWindowDays(): number {
	const select = document.getElementById('ai-usage-window') as HTMLSelectElement | null;
	const value = Number(select?.value ?? 30);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const tokenFormatter = new Intl.NumberFormat();
const compactFormatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function formatTokens(value: number): string {
	return value >= 10000 ? compactFormatter.format(value) : tokenFormatter.format(value);
}

function formatCost(value: number): string {
	return value > 0 && value < 0.1 ? value.toFixed(4) : value.toFixed(2);
}

async function refreshUsage(): Promise<void> {
	const panel = document.getElementById('ai-usage-summary');
	if (!panel) return;

	let data: AiUsagePanelData;
	try {
		data = await requestAiUsage(usageWindowDays());
	} catch (error: unknown) {
		panel.classList.add('is-empty');
		const empty = panel.querySelector('.ai-usage-empty');
		if (empty) empty.textContent = error instanceof Error ? error.message : String(error);
		return;
	}

	const summary = data.summary;
	const hasData = summary.requests > 0 || summary.cachedSegments > 0;
	panel.classList.toggle('is-empty', !hasData);

	const stats = panel.querySelector('.ai-usage-stats');
	const empty = panel.querySelector('.ai-usage-empty');

	// An empty panel because tracking is off says something different from an
	// empty panel because nothing has been translated yet.
	if (empty) {
		empty.textContent = data.recorded
			? (getMessage('aiUsageEmpty') || 'Nothing has been translated yet.')
			: (getMessage('aiUsageOff') || 'Usage tracking is off.');
	}

	if (!hasData) {
		stats?.replaceChildren();
		renderUsageBars(panel.querySelector('.ai-usage-bars'), null);
		renderUsageModels(panel.querySelector('.ai-usage-models'), null);
		return;
	}

	if (stats) {
		const cards: Array<[string, string]> = [
			[getMessage('aiUsageRequests') || 'Requests', tokenFormatter.format(summary.requests)],
			[getMessage('aiUsageTokensIn') || 'Input tokens', formatTokens(summary.promptTokens)],
			[getMessage('aiUsageTokensOut') || 'Output tokens', formatTokens(summary.completionTokens)],
			[
				getMessage('aiUsagePerRequest') || 'Per request',
				summary.requests ? formatTokens(Math.round(summary.totalTokens / summary.requests)) : '—'
			]
		];
		if (summary.savedTokens > 0) {
			cards.push([getMessage('aiUsageSaved') || 'Saved by cache', '≈' + formatTokens(summary.savedTokens)]);
		}
		if (summary.cost !== null) {
			cards.push([getMessage('aiUsageCost') || 'Reference cost', '≈' + formatCost(summary.cost)]);
		}

		stats.replaceChildren(...cards.map(([label, value]) => {
			const card = document.createElement('div');
			card.className = 'ai-usage-stat';
			const valueEl = document.createElement('span');
			valueEl.className = 'ai-usage-stat-value';
			valueEl.textContent = value;
			const labelEl = document.createElement('span');
			labelEl.className = 'ai-usage-stat-label';
			labelEl.textContent = label;
			card.append(valueEl, labelEl);
			return card;
		}));
	}

	renderUsageBars(panel.querySelector('.ai-usage-bars'), summary);
	renderUsageModels(panel.querySelector('.ai-usage-models'), summary);
}

function renderUsageBars(container: Element | null, summary: AiUsageSummary | null): void {
	if (!container) return;
	container.replaceChildren();
	if (!summary) return;

	const days = summary.perDay.filter(day => day.tokens > 0 || day.requests > 0);
	// A single day is a number, not a chart — the stat cards above already say it.
	if (!days.length || summary.perDay.length < 2) return;

	const max = Math.max(...days.map(day => day.tokens), 1);
	const wrap = document.createElement('div');
	wrap.className = 'ai-usage-bar-row';

	for (const day of summary.perDay) {
		const bar = document.createElement('div');
		bar.className = 'ai-usage-bar' + (day.tokens ? '' : ' is-empty');
		const height = day.tokens ? Math.max(6, Math.round((day.tokens / max) * 100)) : 2;
		bar.style.height = `${height}%`;
		bar.title = `${day.day} · ${tokenFormatter.format(day.requests)} · ${tokenFormatter.format(day.tokens)} tokens`;
		wrap.appendChild(bar);
	}

	const caption = document.createElement('div');
	caption.className = 'ai-usage-note';
	// The summary decides how many days to fold (a one-day window would give one
	// unreadable bar), so the caption reports what is actually drawn.
	caption.textContent = getMessage('aiUsageDaily', [String(summary.perDay.length)]) || 'Tokens per day';

	container.append(wrap, caption);
}

function renderUsageModels(container: Element | null, summary: AiUsageSummary | null): void {
	if (!container) return;
	container.replaceChildren();
	if (!summary || !summary.perModel.length) return;

	const table = document.createElement('table');
	table.className = 'ai-usage-table';

	const head = document.createElement('tr');
	for (const label of [
		getMessage('aiUsageModelColumn') || 'Model',
		getMessage('aiUsageRequests') || 'Requests',
		getMessage('aiUsageTokensIn') || 'Input tokens',
		getMessage('aiUsageTokensOut') || 'Output tokens'
	]) {
		const cell = document.createElement('th');
		cell.textContent = label;
		head.appendChild(cell);
	}
	table.appendChild(head);

	for (const model of summary.perModel) {
		const row = document.createElement('tr');
		const cells = [
			model.model + (model.estimatedRequests ? ' ≈' : ''),
			tokenFormatter.format(model.requests),
			formatTokens(model.promptTokens),
			formatTokens(model.completionTokens)
		];
		for (const text of cells) {
			const cell = document.createElement('td');
			cell.textContent = text;
			row.appendChild(cell);
		}
		table.appendChild(row);
	}

	container.appendChild(table);

	// A model whose numbers came from measuring the text, not from the endpoint,
	// is worth saying out loud under the table it just appeared in.
	if (summary.estimatedRequests) {
		const mark = document.createElement('div');
		mark.className = 'ai-usage-note';
		mark.textContent = getMessage('aiUsageEstimatedNote', [String(summary.estimatedRequests), String(summary.requests)]);
		container.appendChild(mark);
	}
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
