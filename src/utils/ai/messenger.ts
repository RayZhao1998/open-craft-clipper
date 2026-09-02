// The UI side of the AI seam: everything that needs the key or the network is
// delegated to the background service worker, exactly like the Craft actions.
// Reader (extension page *and* content script) and the settings page can all
// reach it with the same two calls.

import browser from '../browser-polyfill';
import type { TranslateOptions } from './translate';

export interface AiTestPayload {
	baseUrl: string;
	apiKey: string;
	model: string;
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
		model: payload.model
	}) as { reply?: string; error?: string } | undefined;

	if (!response) throw new Error('The background did not answer.');
	if (response.error) throw new Error(response.error);
	return response.reply || 'OK';
}
