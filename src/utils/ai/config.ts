// Resolving "can we call an LLM right now?" from settings, in one place, so the
// background, the settings page and Reader never disagree.

import { AiChatConfig } from './chat';
import type { Settings } from '../../types/types';

export interface AiStatus {
	configured: boolean;
	/** Which piece is missing, for a human-readable hint. */
	missing?: 'baseUrl' | 'apiKey' | 'model';
	reason?: string;
}

export function resolveAiConfig(settings: Settings | undefined): AiChatConfig | null {
	const ai = settings?.ai;
	if (!ai) return null;
	const baseUrl = (ai.baseUrl || '').trim();
	const model = (ai.model || '').trim();
	if (!baseUrl || !model) return null;
	// Ollama and friends run without a key; everything else is checked by the API.
	return { baseUrl, apiKey: (ai.apiKey || '').trim(), model };
}

export function getAiStatus(settings: Settings | undefined): AiStatus {
	if (!settings?.ai?.enabled) {
		return { configured: false, reason: 'disabled' };
	}
	if (!(settings.ai.baseUrl || '').trim()) {
		return { configured: false, missing: 'baseUrl', reason: 'AI base URL is not set.' };
	}
	if (!(settings.ai.model || '').trim()) {
		return { configured: false, missing: 'model', reason: 'No AI model is set.' };
	}
	if (!(settings.ai.apiKey || '').trim() && !isLocalEndpoint(settings.ai.baseUrl)) {
		return { configured: false, missing: 'apiKey', reason: 'No AI API key is set.' };
	}
	return { configured: true };
}

export function isAiUsable(settings: Settings | undefined): boolean {
	return getAiStatus(settings).configured && resolveAiConfig(settings) !== null;
}

/** Local servers (Ollama, LM Studio, llm.cpp) need no key and are not billed. */
export function isLocalEndpoint(baseUrl: string): boolean {
	const lower = (baseUrl || '').toLowerCase();
	return /:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|ollama\.internal)(:|\/|$)/.test(lower)
		|| /:11434/.test(lower);
}
