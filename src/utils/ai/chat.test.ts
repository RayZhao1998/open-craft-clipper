import { describe, test, expect, vi, afterEach } from 'vitest';
import {
	buildChatRequest,
	chatCompletion,
	estimateTokens,
	maskAiSecrets,
	normalizeAiBaseUrl,
	parseChatResponse,
	pingAiModel,
	resolveEndpoint
} from './chat';

function jsonResponse(body: unknown, status = 200) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('normalizeAiBaseUrl', () => {
	test('adds the scheme and trims slashes and query strings', () => {
		expect(normalizeAiBaseUrl('api.openai.com/v1/')).toBe('https://api.openai.com/v1');
		expect(normalizeAiBaseUrl('https://gateway.example.com/v1/?key=1')).toBe('https://gateway.example.com/v1');
	});

	test('rejects empty and nonsense input', () => {
		expect(() => normalizeAiBaseUrl('   ')).toThrow(/not set/);
	});
});

describe('resolveEndpoint', () => {
	test('appends /chat/completions to an OpenAI-style base', () => {
		expect(resolveEndpoint('https://api.openai.com/v1', 'gpt')).toEqual({
			url: 'https://api.openai.com/v1/chat/completions',
			kind: 'openai'
		});
	});

	test('leaves a full chat/completions URL alone', () => {
		expect(resolveEndpoint('https://proxy.internal/v1/chat/completions', 'gpt').kind).toBe('openai');
		expect(resolveEndpoint('https://proxy.internal/v1/chat/completions', 'gpt').url)
			.toBe('https://proxy.internal/v1/chat/completions');
	});

	test('detects Anthropic by host or by /messages', () => {
		expect(resolveEndpoint('https://api.anthropic.com/v1', 'claude')).toEqual({
			url: 'https://api.anthropic.com/v1/messages',
			kind: 'anthropic'
		});
		expect(resolveEndpoint('https://claude.example.com/v1/messages', 'claude').kind).toBe('anthropic');
	});

	test('builds the Gemini model URL', () => {
		expect(resolveEndpoint('https://generativelanguage.googleapis.com', 'gemini-pro')).toEqual({
			url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
			kind: 'gemini'
		});
	});

	test('keeps an existing Gemini version segment', () => {
		expect(resolveEndpoint('https://generativelanguage.googleapis.com/v1alpha', 'gemini').url)
			.toBe('https://generativelanguage.googleapis.com/v1alpha/models/gemini:generateContent');
	});

	test('maps a bare Ollama host to /api/chat', () => {
		expect(resolveEndpoint('http://127.0.0.1:11434', 'llama')).toEqual({
			url: 'http://127.0.0.1:11434/api/chat',
			kind: 'ollama'
		});
	});
});

describe('buildChatRequest', () => {
	const messages = [
		{ role: 'system' as const, content: 'be brief' },
		{ role: 'user' as const, content: 'hello' }
	];

	test('OpenAI shape: bearer auth, system message inline', () => {
		const request = buildChatRequest('https://api.openai.com/v1', 'sk-1', 'gpt-4o-mini', messages, 300);

		expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(request.headers.Authorization).toBe('Bearer sk-1');
		expect(request.body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 300, stream: false });
		expect((request.body.messages as unknown[]).length).toBe(2);
	});

	test('omits the Authorization header when no key is stored', () => {
		const request = buildChatRequest('http://127.0.0.1:11434', '', 'llama3', messages);
		expect(request.headers.Authorization).toBeUndefined();
	});

	test('Anthropic shape: system prompt is a top-level field', () => {
		const request = buildChatRequest('https://api.anthropic.com/v1', 'sk-ant', 'claude-sonnet-5', messages, 512);

		expect(request.body.system).toBe('be brief');
		expect((request.body.messages as { role: string }[]).every(m => m.role !== 'system')).toBe(true);
		expect(request.headers['x-api-key']).toBe('sk-ant');
		expect(request.headers['anthropic-version']).toBeTruthy();
	});

	test('Gemini shape: parts and systemInstruction', () => {
		const request = buildChatRequest('https://generativelanguage.googleapis.com', 'g-key', 'gemini', messages, 128);

		expect(request.body.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
		expect(request.headers['x-goog-api-key']).toBe('g-key');
	});
});

describe('parseChatResponse', () => {
	test('OpenAI content', () => {
		const parsed = parseChatResponse('openai', {
			choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 5, completion_tokens: 2 }
		});
		expect(parsed.text).toBe('hi');
		expect(parsed.promptTokens).toBe(5);
	});

	test('OpenAI content as parts array', () => {
		const parsed = parseChatResponse('openai', { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] });
		expect(parsed.text).toBe('ab');
	});

	test('Anthropic content blocks', () => {
		const parsed = parseChatResponse('anthropic', { content: [{ type: 'text', text: 'yes' }], stop_reason: 'end_turn' });
		expect(parsed.text).toBe('yes');
		expect(parsed.finishReason).toBe('end_turn');
	});

	test('Gemini candidates', () => {
		const parsed = parseChatResponse('gemini', { candidates: [{ content: { parts: [{ text: 'oui' }] } }] });
		expect(parsed.text).toBe('oui');
	});

	test('Ollama message', () => {
		expect(parseChatResponse('ollama', { message: { content: 'yo' } }).text).toBe('yo');
		expect(parseChatResponse('ollama', { response: 'legacy' }).text).toBe('legacy');
	});

	test('surfaces an API error object', () => {
		expect(() => parseChatResponse('openai', { error: { message: 'model not found' } }))
			.toThrow(/model not found/);
	});

	test('throws when there are no choices', () => {
		expect(() => parseChatResponse('openai', { choices: [] })).toThrow(/choices/);
	});
});

describe('estimateTokens', () => {
	test('CJK costs about a token per glyph, Latin about four characters', () => {
		expect(estimateTokens('中文翻译')).toBe(5);
		expect(estimateTokens('abcdefgh')).toBe(2);
		expect(estimateTokens('')).toBe(0);
	});
});

describe('chatCompletion', () => {
	const config = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret123456', model: 'mini' };
	const messages = [{ role: 'user' as const, content: 'hi' }];

	test('posts and parses an OpenAI answer', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
			choices: [{ message: { content: '{"t":["x"]}' }, finish_reason: 'stop' }]
		}));
		vi.stubGlobal('fetch', fetchMock);

		const result = await chatCompletion(config, messages, { maxTokens: 100 });

		expect(result.text).toBe('{"t":["x"]}');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.openai.com/v1/chat/completions');
		expect((init as RequestInit).method).toBe('POST');
		expect(JSON.parse((init as RequestInit).body as string).model).toBe('mini');
	});

	test('explains a 401 instead of dumping the body', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized: bad key sk-secret123456"}', { status: 401 })));

		await expect(chatCompletion(config, messages)).rejects.toThrow(/rejected your API key/);
	});

	test('explains a 404 with the endpoint it tried', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));

		await expect(chatCompletion(config, messages)).rejects.toThrow(/\/chat\/completions/);
	});

	test('retries once without max_tokens when a gateway rejects the parameter', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response('{"error":"Unsupported parameter: max_tokens"}', { status: 400 }))
			.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await chatCompletion(config, messages, { maxTokens: 100 });

		expect(result.text).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse((fetchMock.mock.calls[1] as unknown as RequestInit[])[1].body as string);
		expect(secondBody.max_tokens).toBeUndefined();
	});

	test('reports a non-JSON body without leaking the key', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('<html>proxy error sk-secret123456</html>')));

		await expect(chatCompletion(config, messages)).rejects.toThrow(/not JSON/);
		await expect(chatCompletion(config, messages)).rejects.not.toThrow(/sk-secret123456/);
	});

	test('keeps a cut-off answer when the caller can use partial output', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })));

		const result = await chatCompletion(config, messages, { tolerateTruncation: true });
		expect(result.text).toBe('partial');
		expect(result.truncated).toBe(true);
	});

	test('reports an empty truncated answer as an output-limit problem', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })));

		await expect(chatCompletion(config, messages, { maxTokens: 120 })).rejects.toThrow(/output limit/);
	});

	test('says so when a thinking model returns only reasoning text', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse({
			choices: [{ message: { content: '', reasoning_content: 'Let me think…' }, finish_reason: 'length' }]
		})));

		await expect(chatCompletion(config, messages)).rejects.toThrow(/only its reasoning text/);

		const tolerated = await chatCompletion(config, messages, { tolerateTruncation: true });
		expect(tolerated.text).toBe('');
		expect(tolerated.reasoning).toContain('Let me think');
	});
});

describe('pingAiModel', () => {
	const config = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret123456', model: 'mini' };

	test('sends no output limit, so a thinking model is not truncated', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await pingAiModel(config)).toBe('OK');

		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.max_tokens).toBeUndefined();
	});

	test('a thinking model is still a working endpoint', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse({
			choices: [{ message: { content: '', reasoning_content: 'Hmm, let me consider…' }, finish_reason: 'length' }]
		})));

		expect(await pingAiModel(config)).toMatch(/only its reasoning text/);
	});

	test('reports an endpoint that answers with nothing at all', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(pingAiModel(config)).rejects.toThrow(/output limit/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('does not retry a request that had no output limit to begin with', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }));
		vi.stubGlobal('fetch', fetchMock);

		await chatCompletion(config, [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 });

		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.max_tokens).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('maskAiSecrets', () => {
	test('hides long keys and sk- tokens', () => {
		expect(maskAiSecrets('key sk-ABCDEFGHIJKLMNOP passed', 'sk-ABCDEFGHIJKLMNOP')).not.toContain('sk-ABCDEFGHIJKLMNOP');
		expect(maskAiSecrets('sk-ABCDEFGHIJKLMNOPQRSTUVW')).toContain('…');
	});
});
