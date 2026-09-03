// Immersive-translation engine: prompt contract, token-aware batching and a
// tolerant response parser. Nothing DOM-specific lives here, so the same code
// serves Reader articles, YouTube transcripts and (later) clipped content.
//
// Token discipline is the whole point of this module:
//   * segments are packed into small batches (≈1.5k source chars) instead of
//     one giant request for the whole article;
//   * segments that need no work (already in the target language, code, numbers,
//     punctuation) never hit the network;
//   * results are cached per model+language so scrolling back is free.

import { AiChatConfig, AiRequestUsage, ChatMessage, chatCompletion, estimateTokens, truncationHint } from './chat';

export const MAX_BATCH_CHARS = 1500;
export const MAX_BATCH_SEGMENTS = 12;
export const MAX_CONCURRENT_REQUESTS = 2;
export const MIN_TRANSLATABLE_CHARS = 2;

/**
 * The contract the parser expects. Kept in one place so the Reader, the
 * background and the tests agree; user prompts are appended as *notes* rather
 * than replacing it, so a translated page can never lose the wire format.
 */
export const TRANSLATE_CONTRACT = [
	'You will receive a JSON array of text segments taken from a web page.',
	'Translate every segment into $TARGET$, then answer with a single JSON object and nothing else:',
	'{"t":["translation 1","translation 2", … ]} containing exactly $COUNT$ strings, in the same order as the input.',
	'Rules:',
	'- Never merge, split, reorder, summarize or comment on segments. One input segment maps to exactly one output string.',
	'- Keep the meaning, tone, tense and register of the source. Do not add explanations.',
	'- Leave URLs, code, file names, numbers, units, emoji, @mentions and hashtags untouched.',
	'- Keep proper nouns as-is unless there is a widely used $TARGET$ form; you may add the original in parentheses on first mention.',
	'- If a segment needs no translation (code, a URL, numbers, an emoji, already in $TARGET$), return it unchanged.',
	'- Segments are standalone fragments: never join them into a paragraph and never quote the input back.'
].join('\n');

export const DEFAULT_TRANSLATE_NOTES = '';

const LANGUAGE_NAMES: Record<string, string> = {
	'af': 'Afrikaans',
	'ar': 'Arabic',
	'bg': 'Bulgarian',
	'bn': 'Bengali',
	'ca': 'Catalan',
	'cs': 'Czech',
	'da': 'Danish',
	'de': 'German',
	'el': 'Greek',
	'en': 'English',
	'es': 'Spanish',
	'fa': 'Persian',
	'fi': 'Finnish',
	'fr': 'French',
	'he': 'Hebrew',
	'hi': 'Hindi',
	'hu': 'Hungarian',
	'id': 'Indonesian',
	'it': 'Italian',
	'ja': 'Japanese',
	'km': 'Khmer',
	'ko': 'Korean',
	'nl': 'Dutch',
	'no': 'Norwegian',
	'pl': 'Polish',
	'pt': 'Portuguese',
	'pt-BR': 'Brazilian Portuguese',
	'ro': 'Romanian',
	'ru': 'Russian',
	'sk': 'Slovak',
	'sv': 'Swedish',
	'th': 'Thai',
	'tl': 'Filipino',
	'tr': 'Turkish',
	'uk': 'Ukrainian',
	'ur': 'Urdu',
	'vi': 'Vietnamese',
	'zh': 'Chinese (Simplified)',
	'zh-CN': 'Chinese (Simplified)',
	'zh-TW': 'Chinese (Traditional)',
	'yue': 'Cantonese'
};

/** Shown in the settings dropdown; the free-text box covers everything else. */
export const LANGUAGE_OPTIONS: Array<{ code: string; label: string }> = [
	{ code: 'zh-CN', label: '简体中文 · Chinese (Simplified)' },
	{ code: 'zh-TW', label: '繁體中文 · Chinese (Traditional)' },
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: '日本語 · Japanese' },
	{ code: 'ko', label: '한국어 · Korean' },
	{ code: 'de', label: 'Deutsch · German' },
	{ code: 'es', label: 'Español · Spanish' },
	{ code: 'fr', label: 'Français · French' },
	{ code: 'it', label: 'Italiano · Italian' },
	{ code: 'pt-BR', label: 'Português (Brasil)' },
	{ code: 'ru', label: 'Русский · Russian' },
	{ code: 'ar', label: 'العربية · Arabic' },
	{ code: 'vi', label: 'Tiếng Việt · Vietnamese' },
	{ code: 'th', label: 'ไทย · Thai' },
	{ code: 'hi', label: 'हिन्दी · Hindi' },
	{ code: 'tr', label: 'Türkçe · Turkish' }
];

export function languageLabel(code: string): string {
	const trimmed = (code || '').trim();
	if (!trimmed) return 'the same language as the source';
	return LANGUAGE_NAMES[trimmed] || LANGUAGE_NAMES[trimmed.split('-')[0]] || trimmed;
}

export interface TranslateOptions {
	/** Language to translate into, e.g. "zh-CN". */
	targetLang: string;
	/** Empty means "detect per segment", which is the default and costs no tokens. */
	sourceLang?: string;
	/** User notes appended to the contract; may be empty. */
	prompt?: string;
	/**
	 * Cost accounting, called once per network batch and once for the cache hits
	 * of a call. Reporting lives with the caller (the background), which is the
	 * only place that knows the model and endpoint being billed.
	 */
	onUsage?: (usage: TranslateUsage) => void;
}

/** One entry in the usage log: a batch that went out, or a cache payoff. */
export interface TranslateUsage extends AiRequestUsage {
	/** `cache` is not a request — it is what the cache meant we did not send. */
	purpose: 'translate' | 'cache';
	/** Segments in the batch, or segments served from the cache. */
	segments: number;
}

export function renderTranslatePrompt(options: TranslateOptions): string {
	const target = languageLabel(options.targetLang);
	const source = (options.sourceLang || '').trim();
	const sourceLabel = source ? languageLabel(source) : 'the language of each segment, detected automatically';

	let prompt = TRANSLATE_CONTRACT
		.split('$TARGET$').join(target)
		.split('$COUNT$').join('the same number of');

	prompt += `\n\nSource language: ${sourceLabel}.\nOutput JSON only — no prose, no Markdown fences.`;

	const notes = (options.prompt || '')
		.split('{targetLang}').join(target)
		.split('{sourceLang}').join(sourceLabel)
		.trim();
	if (notes) {
		prompt += `\n\nTranslator notes (they never override the JSON contract above):\n${notes}`;
	}

	return prompt;
}

export function buildTranslateMessages(texts: string[], options: TranslateOptions): ChatMessage[] {
	return [
		{ role: 'system', content: renderTranslatePrompt(options) },
		{ role: 'user', content: JSON.stringify(texts) }
	];
}

/**
 * Split one oversized block into request-sized pieces without losing anything:
 * every piece keeps the whitespace it was cut on, so `pieces.join('')` gives the
 * original text back. Long quotes, YouTube descriptions and single-paragraph
 * essays are the usual offenders, and without this they would bust the output
 * limit and come back truncated.
 */
export function splitLongSegment(text: string, maxChars = MAX_BATCH_CHARS): string[] {
	if (!text || text.length <= maxChars) return text ? [text] : [];

	const pieces: string[] = [];
	let rest = text;

	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		const floor = Math.floor(maxChars * 0.3);

		let cut = window.lastIndexOf('\n') + 1;

		const sentences = Array.from(window.matchAll(/(?:[.!?\u3002\uff01\uff1f]["'\u201d\u2019)\]]*|\u3001|,)[ \t]*/g));
		const sentenceEnd = sentences.length ? sentences[sentences.length - 1].index! + sentences[sentences.length - 1][0].length : 0;
		if (sentenceEnd > cut) cut = sentenceEnd;

		const space = window.lastIndexOf(' ') + 1;
		if (space > cut) cut = space;

		// Nothing usable to cut on (one enormous word): cut at the budget.
		if (cut <= floor) cut = maxChars;

		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}

	if (rest) pieces.push(rest);
	return pieces;
}

/** Reassemble the translated pieces of one block. */
export function joinTranslationPieces(pieces: (string | null)[]): string | null {
	if (!pieces.length) return null;
	if (pieces.some(piece => piece === null)) {
		// A missing piece means a hole in the middle of the paragraph; show nothing
		// rather than half a sentence.
		return null;
	}
	const joined = pieces.join('').replace(/[ \t]{2,}/g, ' ').trim();
	return joined || null;
}

export interface PackOptions {
	maxChars?: number;
	maxSegments?: number;
}

/**
 * Group segment indices into batches under a shared character budget. Order is
 * preserved so the caller can keep results aligned with the DOM.
 */
export function packSegments(texts: string[], options: PackOptions = {}): number[][] {
	const maxChars = options.maxChars ?? MAX_BATCH_CHARS;
	const maxSegments = options.maxSegments ?? MAX_BATCH_SEGMENTS;

	const batches: number[][] = [];
	let current: number[] = [];
	let currentChars = 0;

	for (let i = 0; i < texts.length; i++) {
		const size = (texts[i] || '').length;
		if (current.length && (currentChars + size > maxChars || current.length >= maxSegments)) {
			batches.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(i);
		currentChars += size;
	}
	if (current.length) batches.push(current);

	return batches;
}

function stripCodeFences(text: string): string {
	let out = text.trim();
	const fenced = out.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced) return fenced[1].trim();
	out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	return out.trim();
}

function sliceFirstJson(text: string): string | null {
	const objectStart = text.indexOf('{');
	const arrayStart = text.indexOf('[');
	const starts = [objectStart, arrayStart].filter(index => index >= 0);
	if (!starts.length) return null;

	const start = Math.min(...starts);
	const open = text[start];
	const close = open === '{' ? '}' : ']';

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) { escaped = false; continue; }
			if (char === '\\') { escaped = true; continue; }
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; continue; }
		if (char === open) depth++;
		else if (char === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function toEntryString(value: unknown): string | null {
	if (typeof value === 'string') return value.trim();
	if (value === null || value === undefined) return null;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		const joined = value.map(part => toEntryString(part) || '').join(' ').trim();
		return joined || null;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of ['t', 'text', 'translation', 'value', 'content']) {
			if (typeof record[key] === 'string') return (record[key] as string).trim();
		}
	}
	return null;
}

// Models love echoing the index back even when told not to ("1. 译文").
function stripEchoedIndex(value: string, position: number): string {
	const match = value.match(/^\s*\(?(\d{1,4})\)\s*[.、)：:]\s*/) || value.match(/^\s*(\d{1,4})\s*[.、)]\s+/);
	if (match && Number(match[1]) === position + 1) {
		return value.slice(match[0].length).trim();
	}
	return value;
}

function extractArray(parsed: any): unknown[] | null {
	if (Array.isArray(parsed)) return parsed;
	if (parsed && typeof parsed === 'object') {
		for (const key of ['t', 'translations', 'segments', 'results', 'items']) {
			if (Array.isArray(parsed[key])) return parsed[key];
		}
		// {"1": "…", "2": "…"} — some models key by index.
		const numeric = Object.keys(parsed).filter(key => /^\d+$/.test(key));
		if (numeric.length) {
			return numeric.sort((a, b) => Number(a) - Number(b)).map(key => parsed[key]);
		}
	}
	return null;
}

/**
 * Turn a raw model answer into exactly `expected` entries (null = untranslated).
 * Never throws: a confused model costs the caller one untranslated block, not a
 * broken page.
 */
export function parseTranslateResponse(raw: string, expected: number): (string | null)[] {
	const text = stripCodeFences(raw || '');
	const out: (string | null)[] = new Array(expected).fill(null);
	if (!text) return out;

	let entries: unknown[] | null = null;
	const jsonSlice = sliceFirstJson(text);

	if (jsonSlice) {
		try {
			entries = extractArray(JSON.parse(jsonSlice));
		} catch {
			entries = null;
		}
	}

	// A single segment is the one case where plain prose is acceptable.
	if (!entries && expected === 1) {
		entries = [text];
	}
	if (!entries) {
		// Cut off mid-JSON: an answer that ran out of tokens still contains the
		// finished translations at the front, and those are worth keeping.
		const salvaged = salvageArrayElements(text);
		if (salvaged.length) entries = salvaged;
	}
	if (!entries) return out;

	for (let i = 0; i < expected && i < entries.length; i++) {
		const value = toEntryString(entries[i]);
		out[i] = value ? stripEchoedIndex(value, i) : null;
	}
	return out;
}

/**
 * Recover the elements that did finish inside a truncated JSON answer: quoted
 * strings sitting at an array element position (preceded by `[` or `,`, not
 * followed by `:`), and only those with a closing quote. That is what makes a
 * `finish_reason: length` answer still translate the first paragraphs instead of
 * losing the whole batch.
 */
export function salvageArrayElements(text: string): string[] {
	const start = text.indexOf('[');
	if (start === -1) return [];

	const fragment = text.slice(start);
	const token = /"((?:[^"\\]|\\.)*)"/g;
	const found: string[] = [];
	let match: RegExpExecArray | null = token.exec(fragment);

	while (match) {
		const before = fragment.slice(0, match.index).trimEnd();
		const previous = before.slice(-1);
		const following = fragment.slice(match.index + match[0].length).replace(/^\s*/, '').slice(0, 1);

		if ((previous === '[' || previous === ',') && following !== ':') {
			try {
				found.push(JSON.parse(match[0]) as string);
			} catch {
				found.push(match[1]);
			}
		}

		match = token.exec(fragment);
	}

	return found;
}

/** Result cache: scrolling back up, or re-opening a page, must cost nothing. */
export class TranslateCache {
	private entries = new Map<string, string>();
	private maxEntries: number;
	private maxChars: number;
	private chars = 0;

	constructor(maxEntries = 4000, maxChars = 600000) {
		this.maxEntries = maxEntries;
		this.maxChars = maxChars;
	}

	private size(): number {
		return this.entries.size;
	}

	get(key: string): string | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			// Refresh recency.
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: string): void {
		if (!key || typeof value !== 'string') return;
		if (this.entries.has(key)) {
			this.chars -= this.entries.get(key)!.length;
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.chars += value.length;

		while (this.entries.size > this.maxEntries || (this.chars > this.maxChars && this.size() > 1)) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const removed = this.entries.get(oldest.value);
			this.chars -= removed ? removed.length : 0;
			this.entries.delete(oldest.value);
		}
	}

	get sizeValue(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
		this.chars = 0;
	}
}

export const translationCache = new TranslateCache();

export function translationCacheKey(config: Pick<AiChatConfig, 'model'>, options: TranslateOptions, text: string): string {
	return [config.model, options.targetLang, (options.sourceLang || ''), (options.prompt || '').slice(0, 40), text].join('\u0000');
}

export interface TranslateBatchResult {
	translations: (string | null)[];
	promptTokens?: number;
	completionTokens?: number;
}

/** One network call for one batch of segments. */
export async function translateBatch(
	texts: string[],
	config: AiChatConfig,
	options: TranslateOptions
): Promise<TranslateBatchResult> {
	if (!texts.length) return { translations: [] };

	const messages = buildTranslateMessages(texts, options);
	const result = await chatCompletion(config, messages, {
		// No max_tokens: a cap of our own is what truncates thinking models mid-
		// answer. The batch is already small, and the endpoint's own limit applies.
		tolerateTruncation: true,
		onUsage: options.onUsage
			? (usage: AiRequestUsage) => options.onUsage?.({ ...usage, purpose: 'translate', segments: texts.length })
			: undefined
	});

	const translations = parseTranslateResponse(result.text, texts.length);

	if (translations.every(value => value === null)) {
		// Nothing usable: say why, because "the paragraph stayed in English" gives
		// the reader nothing to act on. A thinking model that answers only in its
		// reasoning field is the common case here.
		if (result.truncated || result.reasoning) {
			throw new Error(truncationHint(undefined, result.reasoning));
		}
	}

	return {
		translations,
		promptTokens: result.promptTokens,
		completionTokens: result.completionTokens
	};
}

/**
 * Translate an arbitrary list: packs it into token-friendly batches, runs a
 * bounded number of requests in parallel, and consults the cache first.
 * The returned array always lines up with `texts`.
 */
export async function translateTexts(
	texts: string[],
	config: AiChatConfig,
	options: TranslateOptions,
	packOptions: PackOptions = {},
	onBatchDone?: (indices: number[], translations: (string | null)[]) => void
): Promise<(string | null)[]> {
	const out: (string | null)[] = new Array(texts.length).fill(null);
	const cacheKeys = texts.map(text => translationCacheKey(config, options, text));

	const todo: number[] = [];
	let cachedPrompt = 0;
	let cachedCompletion = 0;
	let cachedCount = 0;
	for (let i = 0; i < texts.length; i++) {
		const cached = translationCache.get(cacheKeys[i]);
		if (cached !== undefined) {
			out[i] = cached;
			// What this segment would have cost. Estimates, and marked as such.
			cachedCount++;
			cachedPrompt += estimateTokens(texts[i]);
			cachedCompletion += estimateTokens(cached);
		} else {
			todo.push(i);
		}
	}

	if (cachedCount && options.onUsage) {
		options.onUsage({
			purpose: 'cache',
			segments: cachedCount,
			promptTokens: cachedPrompt,
			completionTokens: cachedCompletion,
			estimated: true,
			durationMs: 0
		});
	}

	if (!todo.length) return out;

	const indexToText = todo.map(index => texts[index]);
	const batches = packSegments(indexToText, packOptions).map(batch => batch.map(offset => todo[offset]));

	const queue = [...batches];
	const workers: Promise<void>[] = [];
	const errors: Error[] = [];

	const runBatch = async (indices: number[]) => {
		const batchTexts = indices.map(index => texts[index]);
		try {
			const result = await translateBatch(batchTexts, config, options);
			indices.forEach((index, offset) => {
				const value = result.translations[offset];
				if (value) {
					out[index] = value;
					translationCache.set(cacheKeys[index], value);
				}
			});
			onBatchDone?.(indices, result.translations);
		} catch (error: unknown) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	};

	const workerCount = Math.min(MAX_CONCURRENT_REQUESTS, queue.length);
	for (let w = 0; w < workerCount; w++) {
		workers.push((async () => {
			while (queue.length) {
				const batch = queue.shift();
				if (batch) await runBatch(batch);
			}
		})());
	}
	await Promise.all(workers);

	if (errors.length && out.every(value => value === null)) {
		throw errors[0];
	}

	return out;
}
