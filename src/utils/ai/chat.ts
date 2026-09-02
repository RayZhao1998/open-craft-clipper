// Minimal chat client for the fork: one OpenAI-style base URL + API key, and it
// just works with OpenAI, Azure-style gateways, vLLM/LM Studio/OneAPI proxies,
// DeepSeek, Moonshot, OpenRouter, Anthropic, Gemini and Ollama.
//
// Everything here is pure request/response plumbing so it can be unit tested and
// called from the background service worker (the only place that sees the key).

export interface AiChatConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	maxTokens?: number;
	/** Hard timeout; a stuck socket would otherwise hold a translation slot forever. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ChatResult {
	text: string;
	finishReason?: string;
	promptTokens?: number;
	completionTokens?: number;
}

export type ChatEndpointKind = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export const DEFAULT_CHAT_TIMEOUT_MS = 45000;

/**
 * Accept whatever the user pastes: with/without scheme, with/without trailing
 * slash, with or without the /chat/completions tail.
 */
export function normalizeAiBaseUrl(input: string): string {
	let url = (input || '').trim();
	if (!url) {
		throw new Error('AI base URL is not set. Add one in Settings → AI.');
	}
	if (!/^https?:\/\//i.test(url)) {
		url = 'https://' + url;
	}
	// Drop the query/hash and any trailing slashes; the endpoint is rebuilt below.
	url = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
	if (!/^https?:\/\/[^\s]+$/i.test(url)) {
		throw new Error(`"${input}" is not a valid URL.`);
	}
	return url;
}

/**
 * Work out which wire protocol a base URL implies, and return the POST target.
 * Users only ever have to think about the base URL.
 */
export function resolveEndpoint(baseUrl: string, model: string): { url: string; kind: ChatEndpointKind } {
	const base = normalizeAiBaseUrl(baseUrl);
	const lower = base.toLowerCase();

	if (/\/messages$/.test(lower) || /api\.anthropic\.com/.test(lower)) {
		if (/\/messages$/.test(lower)) return { url: base, kind: 'anthropic' };
		return { url: `${base}/messages`, kind: 'anthropic' };
	}

	if (/:\s*generatecontent/i.test(base) || /generatecontent/i.test(lower)) {
		return { url: base, kind: 'gemini' };
	}
	if (/generativelanguage\.googleapis\.com/.test(lower)) {
		const hasVersion = /\/v\d+[a-z]*(\/|$)/.test(lower);
		const modelId = (model || '').trim();
		if (!modelId) throw new Error('Add a model name to use a Gemini URL.');
		return { url: `${base}${hasVersion ? '' : '/v1beta'}/models/${encodeURIComponent(modelId)}:generateContent`, kind: 'gemini' };
	}

	// Ollama speaks its own /api/chat (an OpenAI-compatible /v1 also exists and
	// falls through to the OpenAI branch below).
	if (/\/api\/(chat|generate)$/.test(lower)) {
		return { url: base, kind: 'ollama' };
	}
	if (/(:11434|ollama\.internal)$/.test(lower)) {
		return { url: `${base}/api/chat`, kind: 'ollama' };
	}

	if (/\/chat\/completions$/.test(lower)) {
		return { url: base, kind: 'openai' };
	}
	return { url: `${base}/chat/completions`, kind: 'openai' };
}

/** Rough token budget: CJK costs about a token per glyph, Latin ~4 chars. */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		const code = char.codePointAt(0) || 0;
		if (
			(code >= 0x3040 && code <= 0x30ff) ||   // kana
			(code >= 0x3400 && code <= 0x9fff) ||   // CJK ideographs
			(code >= 0xac00 && code <= 0xd7af) ||   // hangul
			(code >= 0xf900 && code <= 0xfaff)
		) {
			cjk++;
		} else {
			other++;
		}
	}
	return Math.ceil(cjk * 1.1 + other / 4);
}

interface BuiltRequest {
	url: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

export function buildChatRequest(
	baseUrl: string,
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	maxTokens?: number
): BuiltRequest {
	const { url, kind } = resolveEndpoint(baseUrl, model);
	const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
	const turns = messages.filter(m => m.role !== 'system');

	if (!model && (kind === 'openai' || kind === 'ollama' || kind === 'anthropic')) {
		throw new Error('No AI model configured. Add one in Settings → AI.');
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Accept': 'application/json'
	};

	if (kind === 'anthropic') {
		const body: Record<string, unknown> = {
			model,
			max_tokens: maxTokens ?? 2048,
			messages: turns.map(m => ({ role: m.role, content: m.content }))
		};
		if (system) body.system = system;
		if (apiKey) {
			headers['x-api-key'] = apiKey;
		}
		headers['anthropic-version'] = '2023-06-01';
		// Anthropic blocks browser origins unless this is present; we call from
		// the service worker, but proxies tend to forward the header anyway.
		headers['anthropic-dangerous-direct-browser-access'] = 'true';
		return { url, body, headers };
	}

	if (kind === 'gemini') {
		const body: Record<string, unknown> = {
			contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
			generationConfig: { maxOutputTokens: maxTokens ?? 2048 }
		};
		if (system) body.systemInstruction = { parts: [{ text: system }] };
		if (apiKey) headers['x-goog-api-key'] = apiKey;
		return { url, body, headers };
	}

	if (kind === 'ollama') {
		const body: Record<string, unknown> = {
			model,
			messages,
			stream: false
		};
		if (maxTokens) body.num_predict = maxTokens;
		if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
		return { url, body, headers };
	}

	const body: Record<string, unknown> = {
		model,
		messages,
		stream: false
	};
	if (maxTokens) body.max_tokens = maxTokens;
	if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
	return { url, body, headers };
}

function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(part => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object') {
				const record = part as Record<string, unknown>;
				if (typeof record.text === 'string') return record.text;
				if (record.type === 'tool_use' || record.type === 'tool_result') return '';
			}
			return '';
		}).join('');
	}
	if (content && typeof content === 'object') {
		const record = content as Record<string, unknown>;
		if (typeof record.text === 'string') return record.text;
	}
	return '';
}

export interface ParsedChatResponse extends ChatResult {}

export function parseChatResponse(kind: ChatEndpointKind, data: any): ParsedChatResponse {
	if (!data || typeof data !== 'object') {
		throw new Error('The AI endpoint returned an empty response.');
	}

	if (data.error) {
		const message = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
		throw new Error(message);
	}

	let text = '';
	let finishReason: string | undefined;
	let promptTokens: number | undefined;
	let completionTokens: number | undefined;

	if (kind === 'anthropic') {
		text = Array.isArray(data.content) ? data.content.map((block: any) => contentToText(block)).join('') : '';
		finishReason = data.stop_reason;
		promptTokens = data.usage?.input_tokens;
		completionTokens = data.usage?.output_tokens;
	} else if (kind === 'gemini') {
		const candidate = data.candidates?.[0];
		text = Array.isArray(candidate?.content?.parts)
			? candidate.content.parts.map((part: any) => contentToText(part)).join('')
			: '';
		finishReason = candidate?.finishReason;
		promptTokens = data.usageMetadata?.promptTokenCount;
		completionTokens = data.usageMetadata?.candidatesTokenCount;
	} else if (kind === 'ollama') {
		text = contentToText(data.message?.content ?? data.response ?? '');
		finishReason = data.done_reason;
		promptTokens = data.prompt_eval_count;
		completionTokens = data.eval_count;
	} else {
		const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
		if (!choice) {
			throw new Error('The AI endpoint did not return any choices.');
		}
		text = contentToText(choice.message?.content ?? choice.text ?? '');
		finishReason = choice.finish_reason;
		promptTokens = data.usage?.prompt_tokens;
		completionTokens = data.usage?.completion_tokens;
	}

	return { text, finishReason, promptTokens, completionTokens };
}

export class AiApiError extends Error {
	status?: number;
	endpoint?: string;

	constructor(message: string, status?: number, endpoint?: string) {
		super(message);
		this.name = 'AiApiError';
		this.status = status;
		this.endpoint = endpoint;
	}
}

/** Never echo the key back into UI or logs — some proxies reflect request headers. */
export function maskAiSecrets(text: string, apiKey?: string): string {
	if (!text) return '';
	let masked = text.replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…');
	if (apiKey && apiKey.length > 4) {
		masked = masked.split(apiKey).join('••••');
	}
	return masked;
}

function describeHttpError(status: number, body: string, endpoint: string): string {
	const detail = maskAiSecrets(body, undefined).slice(0, 300);
	if (status === 401 || status === 403) {
		return `The endpoint rejected your API key (HTTP ${status}).${detail ? ' ' + detail : ''}`;
	}
	if (status === 404) {
		return `Nothing is served at ${endpoint} (HTTP 404). Check the base URL and model name.${detail ? ' ' + detail : ''}`;
	}
	if (status === 429) {
		return `Rate limited by the endpoint (HTTP 429). Try again in a moment, or use a cheaper/faster model.${detail ? ' ' + detail : ''}`;
	}
	return `HTTP ${status}${detail ? ': ' + detail : ''}`;
}

/**
 * POST a chat completion and return the assistant text. Retries once without
 * `max_tokens` for gateways that renamed or dropped the parameter.
 */
export async function chatCompletion(
	config: AiChatConfig,
	messages: ChatMessage[],
	options: ChatOptions = {}
): Promise<ChatResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const relay = () => controller.abort();
	options.signal?.addEventListener('abort', relay);

	const { kind } = resolveEndpoint(config.baseUrl, config.model);

	try {
		let request = buildChatRequest(config.baseUrl, config.apiKey, config.model, messages, options.maxTokens);
		let response = await fetch(request.url, {
			method: 'POST',
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: controller.signal
		});

		if (!response.ok && request.body.max_tokens !== undefined) {
			const errorBody = await response.clone().text().catch(() => '');
			if (response.status === 400 && /max_tokens|max_completion_tokens|unsupported parameter/i.test(errorBody)) {
				request = buildChatRequest(config.baseUrl, config.apiKey, config.model, messages, undefined);
				response = await fetch(request.url, {
					method: 'POST',
					headers: request.headers,
					body: JSON.stringify(request.body),
					signal: controller.signal
				});
			}
		}

		const raw = await response.text();
		if (!response.ok) {
			throw new AiApiError(describeHttpError(response.status, raw, request.url), response.status, request.url);
		}

		let data: any;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new AiApiError(`The endpoint returned a response that is not JSON: ${maskAiSecrets(raw, config.apiKey).slice(0, 200)}`, response.status, request.url);
		}

		const parsed = parseChatResponse(kind, data);
		if (parsed.finishReason && /length|max_tokens|MAX_TOKENS/i.test(parsed.finishReason)) {
			throw new AiApiError('The response was cut off by the output limit. Try fewer segments per request.', response.status, request.url);
		}
		if (!parsed.text.trim()) {
			throw new AiApiError('The model returned an empty answer.', response.status, request.url);
		}

		return parsed;
	} catch (error: unknown) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw new AiApiError(`The AI endpoint did not answer within ${Math.round(timeoutMs / 1000)}s.`);
		}
		if (error instanceof AiApiError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new AiApiError(maskAiSecrets(message, config.apiKey));
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', relay);
	}
}

/** Cheap round-trip used by the settings page "Test" button. */
export async function pingAiModel(config: AiChatConfig): Promise<string> {
	const result = await chatCompletion(config, [
		{ role: 'system', content: 'Reply with exactly: OK' },
		{ role: 'user', content: 'ping' }
	], { maxTokens: 16, timeoutMs: 20000 });
	return result.text.trim().slice(0, 60);
}
