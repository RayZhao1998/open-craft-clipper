import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
	estimateOutputBudget,
	joinTranslationPieces,
	languageLabel,
	packSegments,
	parseTranslateResponse,
	renderTranslatePrompt,
	splitLongSegment,
	translationCacheKey,
	translateTexts,
	TranslateCache,
	TRANSLATE_CONTRACT
} from './translate';
import * as chat from './chat';

vi.mock('./chat', async () => {
	const actual = await vi.importActual<typeof import('./chat')>('./chat');
	return { ...actual, chatCompletion: vi.fn() };
});

const mockedChat = vi.mocked(chat.chatCompletion);

beforeEach(() => {
	mockedChat.mockReset();
});

describe('renderTranslatePrompt', () => {
	test('names the target language and the JSON contract', () => {
		const prompt = renderTranslatePrompt({ targetLang: 'zh-CN' });

		expect(prompt).toContain('Chinese (Simplified)');
		expect(prompt).toContain('{"t":');
		expect(prompt).toContain('Source language: the language of each segment, detected automatically');
	});

	test('appends user notes without touching the contract', () => {
		const prompt = renderTranslatePrompt({
			targetLang: 'en',
			prompt: 'Use British spelling.'
		});

		expect(prompt).toContain('Use British spelling.');
		expect(prompt.indexOf('{"t":')).toBeLessThan(prompt.indexOf('Use British spelling.'));
		expect(prompt).toContain('never override the JSON contract');
	});

	test('substitutes variables inside the notes', () => {
		const prompt = renderTranslatePrompt({
			targetLang: 'ja',
			sourceLang: 'en',
			prompt: 'Explain jargon for {targetLang} readers of {sourceLang} originals.'
		});

		expect(prompt).toContain('Explain jargon for Japanese readers of English originals.');
		expect(prompt).not.toContain('{targetLang}');
	});

	test('maps known codes and passes unknown ones through', () => {
		expect(languageLabel('zh-TW')).toBe('Chinese (Traditional)');
		expect(languageLabel('pt-BR')).toBe('Brazilian Portuguese');
		expect(languageLabel('xx')).toBe('xx');
		expect(renderTranslatePrompt({ targetLang: 'xx' })).toContain('xx');
	});
});

describe('packSegments', () => {
	test('respects the segment cap', () => {
		const texts = new Array(30).fill('short line');
		const batches = packSegments(texts, { maxChars: 100000, maxSegments: 12 });

		expect(batches.length).toBe(3);
		expect(batches[0].length).toBe(12);
		expect(batches.flatMap(batch => batch)).toEqual(Array.from({ length: 30 }, (_, i) => i));
	});

	test('respects the character budget and keeps order', () => {
		const texts = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)];
		const batches = packSegments(texts, { maxChars: 1000, maxSegments: 50 });

		expect(batches).toEqual([[0], [1], [2]]);
	});

	test('packs many short fragments into one request', () => {
		const texts = Array.from({ length: 20 }, () => 'hello there');
		const batches = packSegments(texts, { maxChars: 1400, maxSegments: 12 });

		expect(batches.length).toBe(2);
		expect(batches[0].length).toBe(12);
	});

	test('an oversized single segment still gets sent', () => {
		expect(packSegments(['x'.repeat(5000)])).toEqual([[0]]);
	});
});

describe('parseTranslateResponse', () => {
	test('reads the documented object shape', () => {
		expect(parseTranslateResponse('{"t":["一","二"]}', 2)).toEqual(['一', '二']);
	});

	test('tolerates Markdown fences and prose around the JSON', () => {
		expect(parseTranslateResponse('```json\n{"t":["one","two"]}\n```', 2)).toEqual(['one', 'two']);
		expect(parseTranslateResponse('Sure!\n{"t":["one"]} hope that helps', 1)).toEqual(['one']);
	});

	test('accepts a bare array', () => {
		expect(parseTranslateResponse('["one","two"]', 2)).toEqual(['one', 'two']);
	});

	test('accepts an object keyed by index', () => {
		expect(parseTranslateResponse('{"1":"one","2":"two"}', 2)).toEqual(['one', 'two']);
	});

	test('strips echoed numbering', () => {
		expect(parseTranslateResponse('{"t":["1. 第一个","2. 第二个"]}', 2)).toEqual(['第一个', '第二个']);
	});

	test('accepts plain prose when only one segment was sent', () => {
		expect(parseTranslateResponse('这是一段译文。', 1)).toEqual(['这是一段译文。']);
	});

	test('pads missing entries with null instead of throwing', () => {
		expect(parseTranslateResponse('{"t":["only"]}', 3)).toEqual(['only', null, null]);
	});

	test('returns nulls for junk', () => {
		expect(parseTranslateResponse('I cannot help with that.', 3)).toEqual([null, null, null]);
		expect(parseTranslateResponse('', 2)).toEqual([null, null]);
	});

	test('does not truncate a longer answer into fewer slots', () => {
		expect(parseTranslateResponse('{"t":["a","b","c"]}', 2)).toEqual(['a', 'b']);
	});
});

describe('TranslateCache', () => {
	test('evicts the oldest entry past the cap', () => {
		const cache = new TranslateCache(2);
		cache.set('a', '1');
		cache.set('b', '2');
		cache.set('c', '3');

		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('c')).toBe('3');
	});

	test('reading an entry refreshes it before eviction', () => {
		const cache = new TranslateCache(2);
		cache.set('a', '1');
		cache.set('b', '2');
		expect(cache.get('a')).toBe('1');
		cache.set('c', '3');

		expect(cache.get('a')).toBe('1');
		expect(cache.get('b')).toBeUndefined();
	});
});

describe('splitLongSegment', () => {
	test('leaves normal blocks alone', () => {
		expect(splitLongSegment('a short paragraph', 1400)).toEqual(['a short paragraph']);
		expect(splitLongSegment('', 1400)).toEqual([]);
	});

	test('is lossless: the pieces join back into the original', () => {
		const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} explains something useful.`).join(' ');
		const pieces = splitLongSegment(text, 500);

		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.join('')).toBe(text);
		expect(pieces.every(piece => piece.length <= 500 + 40)).toBe(true);
	});

	test('prefers line boundaries', () => {
		const text = 'first line.\n' + 'second line that is long enough to matter.\n'.repeat(30);
		const pieces = splitLongSegment(text, 120);

		expect(pieces.join('')).toBe(text);
		expect(pieces.every(piece => !piece.startsWith(' '))).toBe(true);
	});

	test('splits an enormous word at the budget rather than dropping it', () => {
		const text = 'x'.repeat(1200);
		const pieces = splitLongSegment(text, 500);

		expect(pieces.join('')).toBe(text);
		expect(pieces.length).toBe(3);
	});
});

describe('joinTranslationPieces', () => {
	test('reassembles pieces and collapses stray spacing', () => {
		expect(joinTranslationPieces(['Erster Teil. ', 'Zweiter Teil.'])).toBe('Erster Teil. Zweiter Teil.');
	});

	test('keeps line breaks', () => {
		expect(joinTranslationPieces([' erste\n', 'zweite'])).toBe('erste\nzweite');
	});

	test('refuses to show half a paragraph', () => {
		expect(joinTranslationPieces(['ok', null])).toBeNull();
		expect(joinTranslationPieces([])).toBeNull();
		expect(joinTranslationPieces(['   '])).toBeNull();
	});
});

describe('estimateOutputBudget', () => {
	test('grows with the payload and stays bounded', () => {
		expect(estimateOutputBudget(['tiny'])).toBe(160);
		expect(estimateOutputBudget(['a'.repeat(4000), 'b'.repeat(4000)])).toBeLessThanOrEqual(4000);
		expect(estimateOutputBudget([''.repeat(10)])).toBe(160);
	});
});

describe('translateTexts', () => {
	const config = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'mini' };

	test('keeps results aligned with the input across batches', async () => {
		mockedChat.mockImplementation(async (_config, messages) => {
			const inputs = JSON.parse(messages[1].content as string) as string[];
			return { text: JSON.stringify({ t: inputs.map(text => `«${text}»`) }) };
		});

		const texts = ['one', 'two', 'three', 'four'];
		const out = await translateTexts(texts, config, { targetLang: 'de' }, { maxChars: 12, maxSegments: 2 });

		expect(out).toEqual(['«one»', '«two»', '«three»', '«four»']);
		expect(mockedChat).toHaveBeenCalledTimes(2);
	});

	test('serves repeat lookups from the cache without a request', async () => {
		const calls: string[][] = [];
		mockedChat.mockImplementation(async (_config, messages) => {
			const inputs = JSON.parse(messages[1].content as string) as string[];
			calls.push(inputs);
			return { text: JSON.stringify({ t: inputs.map(text => text.toUpperCase()) }) };
		});

		const options = { targetLang: 'fr' };
		const texts = ['alpha', 'beta'];
		await translateTexts(texts, config, options);
		const requestsAfterFirst = calls.length;

		const again = await translateTexts(texts, config, options);

		expect(again).toEqual(['ALPHA', 'BETA']);
		expect(calls.length).toBe(requestsAfterFirst);
	});

	test('a failed batch leaves its slots untranslated but keeps the rest', async () => {
		mockedChat.mockImplementation(async (_config, messages) => {
			const inputs = JSON.parse(messages[1].content as string) as string[];
			if (inputs[0] === 'boom') throw new Error('429 rate limited');
			return { text: JSON.stringify({ t: inputs.map(text => `ok:${text}`) }) };
		});

		const out = await translateTexts(['first', 'boom'], config, { targetLang: 'de' }, { maxChars: 1, maxSegments: 1 });

		expect(out[0]).toBe('ok:first');
		expect(out[1]).toBeNull();
	});

	test('throws when nothing could be translated so the caller can back off', async () => {
		mockedChat.mockRejectedValue(new Error('401 key rejected'));

		await expect(translateTexts(['a'], config, { targetLang: 'de' })).rejects.toThrow(/401/);
	});

	test('cache keys separate model and target language', () => {
		const base = translationCacheKey({ model: 'mini' }, { targetLang: 'de' }, 'text');
		expect(base).not.toBe(translationCacheKey({ model: 'big' }, { targetLang: 'de' }, 'text'));
		expect(base).not.toBe(translationCacheKey({ model: 'mini' }, { targetLang: 'fr' }, 'text'));
	});
});

describe('contract', () => {
	test('mentions the one-segment-per-line rule', () => {
		expect(TRANSLATE_CONTRACT).toContain('exactly');
		expect(TRANSLATE_CONTRACT).toContain('$COUNT$');
		expect(TRANSLATE_CONTRACT).toContain('$TARGET$');
	});
});
