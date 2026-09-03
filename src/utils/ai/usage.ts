// What the AI endpoint was asked to do, and what it cost.
//
// The request layer already reads `usage` out of every protocol it speaks; this
// keeps those numbers, in one rolling local list, so Settings → AI can answer
// "what did reading that article cost me?". Nothing here changes what is sent:
// recording happens on requests that were happening anyway.

import browser from '../browser-polyfill';

export type AiUsagePurpose = 'translate' | 'test' | 'cache';

export interface AiUsageEntry {
	/** Epoch milliseconds — windowing is arithmetic, not string parsing. */
	time: number;
	model: string;
	/** Endpoint host only. Never the key, never the path. */
	host: string;
	/**
	 * `cache` is not a request: it is a segment served from the translation
	 * cache, kept so the UI can show what the cache saved.
	 */
	purpose: AiUsagePurpose;
	promptTokens: number;
	completionTokens: number;
	/** The endpoint sent no usage, so these are `estimateTokens()` numbers. */
	estimated: boolean;
	durationMs: number;
	/** Segments in the batch, for "tokens per segment" sanity checks. */
	segments: number;
}

/** Proposed usage, before the defaults are filled in. */
export type AiUsageInput = Partial<AiUsageEntry> & Pick<AiUsageEntry, 'purpose' | 'model'>;

export interface AiUsageModelSummary {
	model: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	estimatedRequests: number;
}

export interface AiUsageDay {
	/** Local day, `YYYY-MM-DD`. */
	day: string;
	tokens: number;
	requests: number;
}

export interface AiUsageSummary {
	requests: number;
	testRequests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Requests whose token counts we estimated rather than read from the wire. */
	estimatedRequests: number;
	cachedSegments: number;
	/** Tokens the cache meant we did not send (both directions). */
	savedTokens: number;
	/** Wall-clock time spent waiting for answers. */
	durationMs: number;
	perModel: AiUsageModelSummary[];
	perDay: AiUsageDay[];
	/** Null when no price is configured; approximate whenever it is set. */
	cost: number | null;
}

export interface AiPricing {
	/** Price per million prompt tokens, in whatever currency the provider bills. */
	input: number;
	/** Price per million completion tokens. */
	output: number;
}

const USAGE_KEY = 'ai_usage';
const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 1500;

// --- Storage ----------------------------------------------------------------
// storage.local, not sync: this list grows on every article and belongs to one
// device. It is deliberately outside the settings export too.

let entries: AiUsageEntry[] | null = null;
let loading: Promise<AiUsageEntry[]> | null = null;
/** The memory list is ahead of storage. */
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

function isEntry(value: unknown): value is AiUsageEntry {
	const entry = value as AiUsageEntry | null;
	return !!entry && typeof entry === 'object'
		&& typeof entry.time === 'number' && Number.isFinite(entry.time)
		&& typeof entry.model === 'string'
		&& typeof entry.purpose === 'string'
		&& typeof entry.promptTokens === 'number' && Number.isFinite(entry.promptTokens)
		&& typeof entry.completionTokens === 'number' && Number.isFinite(entry.completionTokens);
}

function trim(list: AiUsageEntry[], now: number): AiUsageEntry[] {
	const fresh = list.filter(entry => entry.time >= now - MAX_AGE_MS);
	// Newest first, so a cap drops the oldest without another sort.
	return fresh.sort((a, b) => b.time - a.time).slice(0, MAX_ENTRIES);
}

async function loadEntries(): Promise<AiUsageEntry[]> {
	// One read, shared: translation runs batches in parallel, and two loads that
	// each assign `entries` would drop whichever entry was added first.
	if (entries) return entries;
	if (!loading) {
		loading = (async () => {
			try {
				const stored = await browser.storage.local.get(USAGE_KEY) as Record<string, unknown>;
				const raw = Array.isArray(stored?.[USAGE_KEY]) ? stored[USAGE_KEY] as unknown[] : [];
				entries = trim(raw.filter(isEntry), Date.now());
			} catch {
				entries = entries || [];
			}
			return entries;
		})();
	}
	return loading;
}

function scheduleFlush(): void {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushUsage();
	}, FLUSH_DELAY_MS);
}

/**
 * Persist the in-memory list. Translation records one entry per batch, so the
 * write is debounced: an article flushes once when it stops, not per request.
 * A failed write leaves the list dirty, so the next flush retries it.
 */
export async function flushUsage(): Promise<void> {
	if (flushing) await flushing;
	if (!dirty) return;

	flushing = (async () => {
		try {
			const list = trim((await loadEntries()) || [], Date.now());
			await browser.storage.local.set({ [USAGE_KEY]: list });
			dirty = false;
		} catch (error) {
			console.warn('[AI usage] could not save:', error);
		}
	})();
	await flushing;
	flushing = null;
}

export async function recordAiUsage(usage: AiUsageInput): Promise<void> {
	const now = Date.now();
	const list = await loadEntries();

	const entry: AiUsageEntry = {
		time: typeof usage.time === 'number' ? usage.time : now,
		model: usage.model || 'unknown',
		host: usage.host || '',
		purpose: usage.purpose,
		promptTokens: Math.max(0, Math.round(usage.promptTokens || 0)),
		completionTokens: Math.max(0, Math.round(usage.completionTokens || 0)),
		estimated: Boolean(usage.estimated),
		durationMs: Math.max(0, Math.round(usage.durationMs || 0)),
		segments: Math.max(0, Math.round(usage.segments || 0))
	};

	if (!Number.isFinite(entry.time)) entry.time = now;

	list.unshift(entry);
	dirty = true;
	scheduleFlush();
}

export async function getAiUsage(): Promise<AiUsageEntry[]> {
	await flushUsage();
	return [...((await loadEntries()) || [])];
}

export async function clearAiUsage(): Promise<void> {
	// Null rather than [] so the next read goes back to storage, which is empty
	// by then — a cached empty array would hide anything recorded elsewhere.
	entries = null;
	loading = null;
	dirty = false;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	try {
		await browser.storage.local.remove(USAGE_KEY);
	} catch (error) {
		console.warn('[AI usage] could not clear:', error);
	}
}

// --- Pricing ----------------------------------------------------------------

/**
 * Settings holds prices as text because the field is free-form by intent (a yen
 * price, a comma-grouped dollar price). Anything that is not a positive number
 * means "no price", which turns the cost line off rather than showing 0.
 */
export function parseAiPrice(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value > 0 ? value : null;
	}
	if (typeof value !== 'string') return null;
	const digits = value.replace(/[^0-9.,]/g, '').replace(/,/g, '');
	if (!digits) return null;
	const parsed = Number(digits);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseAiPricing(input: unknown, output: unknown): AiPricing | null {
	const inPrice = parseAiPrice(input);
	const outPrice = parseAiPrice(output);
	if (inPrice === null && outPrice === null) return null;
	return { input: inPrice ?? 0, output: outPrice ?? 0 };
}

// --- Aggregation ------------------------------------------------------------

function dayKey(time: number): string {
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

export interface SummarizeOptions {
	/** Include entries at or after this time (epoch ms). */
	since: number;
	until?: number;
	pricing?: AiPricing | null;
	/** Number of daily buckets in `perDay`, ending today. */
	days?: number;
	/** Injectable for tests. */
	now?: number;
}

/**
 * Fold a window of entries into the numbers the settings page renders. Cache
 * entries are kept out of the token and request totals — they are what did *not*
 * go out — and reported as `savedTokens` instead.
 */
export function summarizeAiUsage(all: AiUsageEntry[], options: SummarizeOptions): AiUsageSummary {
	const now = options.now ?? Date.now();
	const until = options.until ?? now + 1;
	const list = Array.isArray(all) ? all.filter(isEntry) : [];

	const summary: AiUsageSummary = {
		requests: 0,
		testRequests: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		estimatedRequests: 0,
		cachedSegments: 0,
		savedTokens: 0,
		durationMs: 0,
		perModel: [],
		perDay: [],
		cost: null
	};

	const byModel = new Map<string, AiUsageModelSummary>();
	const byDay = new Map<string, AiUsageDay>();

	const bucketCount = Math.max(1, options.days ?? 14);
	// Walk by calendar day rather than by 24h steps, so a DST week does not
	// double up or drop a bar.
	const today = new Date(now);
	const firstDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (bucketCount - 1));
	const firstBucket = firstDate.getTime();

	for (const entry of list) {
		if (entry.time < options.since || entry.time >= until) continue;

		if (entry.purpose === 'cache') {
			summary.cachedSegments += Math.max(1, entry.segments);
			summary.savedTokens += entry.promptTokens + entry.completionTokens;
			continue;
		}

		const tokens = entry.promptTokens + entry.completionTokens;
		summary.requests++;
		if (entry.purpose === 'test') summary.testRequests++;
		summary.promptTokens += entry.promptTokens;
		summary.completionTokens += entry.completionTokens;
		summary.totalTokens += tokens;
		summary.durationMs += entry.durationMs;
		if (entry.estimated) summary.estimatedRequests++;

		const model = byModel.get(entry.model) || {
			model: entry.model, requests: 0, promptTokens: 0, completionTokens: 0, estimatedRequests: 0
		};
		model.requests++;
		model.promptTokens += entry.promptTokens;
		model.completionTokens += entry.completionTokens;
		if (entry.estimated) model.estimatedRequests++;
		byModel.set(entry.model, model);

		if (entry.time >= firstBucket) {
			const key = dayKey(entry.time);
			const day = byDay.get(key) || { day: key, tokens: 0, requests: 0 };
			day.tokens += tokens;
			day.requests++;
			byDay.set(key, day);
		}
	}

	summary.perModel = [...byModel.values()].sort((a, b) =>
		(b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens) || a.model.localeCompare(b.model));

	// Fill empty days so the bars keep a steady rhythm instead of collapsing to
	// the days that happen to have data.
	const perDay: AiUsageDay[] = [];
	for (let i = 0; i < bucketCount; i++) {
		const key = dayKey(new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + i).getTime());
		perDay.push(byDay.get(key) || { day: key, tokens: 0, requests: 0 });
	}
	summary.perDay = perDay;

	if (options.pricing) {
		summary.cost = (summary.promptTokens / 1_000_000) * options.pricing.input
			+ (summary.completionTokens / 1_000_000) * options.pricing.output;
	}

	return summary;
}

export const emptyAiUsageSummary: AiUsageSummary = summarizeAiUsage([], { since: 0, days: 1 });
