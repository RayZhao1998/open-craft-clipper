// The UI side of the AI seam: everything that needs the key or the network is
// delegated to the background service worker, exactly like the Craft actions.
// Reader (extension page *and* content script) and the settings page can all
// reach it with the same two calls.

import browser from '../browser-polyfill';
import type { TranslateOptions } from './translate';
import type { AiUsageSummary } from './usage';

export interface AiTestPayload {
	baseUrl: string;
	apiKey: string;
	model: string;
	extraParams?: string;
}

export interface AiTranslateResponse {
	translations?: (string | null)[];
	error?: string;
}

export async function requestTranslations(
	texts: string[],
	options: TranslateOptions
): Promise<(string | null)[]> {
	if (!texts.length) return [];

	const response = await browser.runtime.sendMessage({
		action: 'aiTranslate',
		texts,
		targetLang: options.targetLang,
		sourceLang: options.sourceLang || '',
		prompt: options.prompt || ''
	}) as AiTranslateResponse | undefined;

	if (!response) {
		throw new Error('The background did not answer the translation request.');
	}
	if (response.error) {
		throw new Error(response.error);
	}
	return response.translations || texts.map(() => null);
}

/**
 * Test a set of credentials that may not be saved yet (the settings page keeps
 * them in the form until the user saves).
 */
export async function requestAiTest(payload: AiTestPayload): Promise<string> {
	const response = await browser.runtime.sendMessage({
		action: 'aiTest',
		baseUrl: payload.baseUrl,
		apiKey: payload.apiKey,
		model: payload.model,
		extraParams: payload.extraParams || ''
	}) as { reply?: string; error?: string } | undefined;

	if (!response) throw new Error('The background did not answer.');
	if (response.error) throw new Error(response.error);
	return response.reply || 'OK';
}

export interface AiUsagePanelData {
	summary: AiUsageSummary;
	/** Whether tracking is on right now — the panel says so when it is off. */
	recorded: boolean;
	/** Entries kept on this device, whatever the window. */
	entries: number;
}

/**
 * One window of the usage log. The folding happens in the background, where the
 * prices and the log live, so the page never ships the whole list around.
 *
 * @param windowDays 1 for today, 7/30 for a window, 0 for everything kept.
 */
export async function requestAiUsage(windowDays: number): Promise<AiUsagePanelData> {
	const response = await browser.runtime.sendMessage({ action: 'aiUsage', window: windowDays }) as
		(AiUsagePanelData & { error?: string }) | undefined;

	if (!response || response.error) throw new Error(response?.error || 'The background did not answer.');
	return { summary: response.summary, recorded: response.recorded, entries: response.entries };
}

export async function requestAiUsageClear(): Promise<void> {
	const response = await browser.runtime.sendMessage({ action: 'aiUsageClear' }) as { error?: string } | undefined;
	if (response?.error) throw new Error(response.error);
}

export interface AiCachePanelData {
	/** Remembered translations on this device. */
	count: number;
	/** Their size in characters, which is what the budget counts — not bytes on disk. */
	chars: number;
	/** Whether persistence is on right now, so the panel can say why it is empty. */
	persisted: boolean;
}

export async function requestAiCacheStats(): Promise<AiCachePanelData> {
	const response = await browser.runtime.sendMessage({ action: 'aiCache' }) as
		(Partial<AiCachePanelData> & { error?: string }) | undefined;

	if (!response || response.error) throw new Error(response?.error || 'The background did not answer.');
	return { count: response.count ?? 0, chars: response.chars ?? 0, persisted: response.persisted !== false };
}

export async function requestAiCacheClear(): Promise<void> {
	const response = await browser.runtime.sendMessage({ action: 'aiCacheClear' }) as { error?: string } | undefined;
	if (response?.error) throw new Error(response.error);
}
