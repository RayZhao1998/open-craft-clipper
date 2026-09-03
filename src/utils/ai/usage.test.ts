import { describe, test, expect, beforeEach, vi } from 'vitest';
import browser from '../browser-polyfill';
import {
	summarizeAiUsage,
	parseAiPrice,
	parseAiPricing,
	recordAiUsage,
	getAiUsage,
	clearAiUsage,
	flushUsage,
	AiUsageEntry,
} from './usage';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 3, 12, 0, 0).getTime();

function entry(overrides: Partial<AiUsageEntry> = {}): AiUsageEntry {
	return {
		time: NOW,
		model: 'gpt-4o-mini',
		host: 'api.openai.com',
		purpose: 'translate',
		promptTokens: 1000,
		completionTokens: 500,
		estimated: false,
		durationMs: 1200,
		segments: 8,
		...overrides,
	};
}

describe('summarizeAiUsage', () => {
	test('folds requests in the window and ignores what is outside it', () => {
		const summary = summarizeAiUsage([
			entry(),
			entry({ time: NOW - 2 * DAY, promptTokens: 40, completionTokens: 10 }),
		], { since: NOW - DAY, now: NOW });

		expect(summary.requests).toBe(1);
		expect(summary.promptTokens).toBe(1000);
		expect(summary.completionTokens).toBe(500);
		expect(summary.totalTokens).toBe(1500);
		expect(summary.durationMs).toBe(1200);
	});

	test('requests and test pings are counted, cache entries are not', () => {
		const summary = summarizeAiUsage([
			entry(),
			entry({ purpose: 'test', promptTokens: 20, completionTokens: 2 }),
			entry({ purpose: 'cache', segments: 12, promptTokens: 900, completionTokens: 300 }),
		], { since: NOW - DAY, now: NOW });

		expect(summary.requests).toBe(2);
		expect(summary.testRequests).toBe(1);
		expect(summary.totalTokens).toBe(1522);
		expect(summary.cachedSegments).toBe(12);
		expect(summary.savedTokens).toBe(1200);
	});

	test('marks how much of the total is estimated rather than reported', () => {
		const summary = summarizeAiUsage([
			entry({ estimated: true }),
			entry(),
			entry({ estimated: true, purpose: 'cache' }),
		], { since: NOW - DAY, now: NOW });

		// Cache entries are not requests, so an estimated one is not counted here.
		expect(summary.estimatedRequests).toBe(1);
		expect(summary.requests).toBe(2);
	});

	test('groups by model, priciest first', () => {
		const summary = summarizeAiUsage([
			entry({ model: 'cheap-model', promptTokens: 100, completionTokens: 50 }),
			entry({ model: 'big-model', promptTokens: 5000, completionTokens: 2000 }),
			entry({ model: 'big-model', promptTokens: 1000, completionTokens: 1000 }),
		], { since: NOW - DAY, now: NOW });

		expect(summary.perModel.map(m => m.model)).toEqual(['big-model', 'cheap-model']);
		expect(summary.perModel[0]).toMatchObject({ requests: 2, promptTokens: 6000, completionTokens: 3000 });
	});

	test('fills every day of the chart, including the quiet ones', () => {
		const summary = summarizeAiUsage([
			entry({ time: NOW }),
			entry({ time: NOW - 2 * DAY }),
			// Older than the chart window.
			entry({ time: NOW - 40 * DAY }),
		], { since: NOW - 14 * DAY, days: 14, now: NOW });

		expect(summary.perDay).toHaveLength(14);
		expect(summary.perDay[summary.perDay.length - 1]).toMatchObject({ tokens: 1500, requests: 1 });
		expect(summary.perDay[summary.perDay.length - 3]).toMatchObject({ tokens: 1500, requests: 1 });
		expect(summary.perDay.reduce((sum, day) => sum + day.requests, 0)).toBe(2);
	});

	test('cost is only shown when a price was set', () => {
		const entries = [entry({ promptTokens: 1_000_000, completionTokens: 500_000 })];

		expect(summarizeAiUsage(entries, { since: 0, now: NOW }).cost).toBeNull();
		expect(summarizeAiUsage(entries, {
			since: 0, now: NOW, pricing: { input: 2.5, output: 10 }
		}).cost).toBeCloseTo(2.5 + 5, 10);
	});

	test('junk in storage does not become a request', () => {
		const summary = summarizeAiUsage(
			[entry(), null, undefined, {}, { time: 'x' }] as unknown as AiUsageEntry[],
			{ since: 0, now: NOW }
		);
		expect(summary.requests).toBe(1);
	});
});

describe('parseAiPrice / parseAiPricing', () => {
	test('accepts what a person would paste and rejects the rest', () => {
		expect(parseAiPrice('2.5')).toBe(2.5);
		expect(parseAiPrice(' 1,200 ')).toBe(1200);
		expect(parseAiPrice('$0.07')).toBe(0.07);
		expect(parseAiPrice('¥1.00')).toBe(1);

		expect(parseAiPrice('')).toBeNull();
		expect(parseAiPrice('0')).toBeNull();
		expect(parseAiPrice('free')).toBeNull();
		expect(parseAiPrice(undefined)).toBeNull();
		expect(parseAiPrice(-3)).toBeNull();
	});

	test('one price is enough; both absent means no cost line', () => {
		expect(parseAiPricing('', '')).toBeNull();
		expect(parseAiPricing('2', '')).toEqual({ input: 2, output: 0 });
		expect(parseAiPricing('', '8')).toEqual({ input: 0, output: 8 });
		expect(parseAiPricing('2', '8')).toEqual({ input: 2, output: 8 });
	});
});

describe('recording', () => {
	const localStore = new Map<string, unknown>();

	beforeEach(async () => {
		vi.restoreAllMocks();
		localStore.clear();
		vi.spyOn(browser.storage.local, 'get').mockImplementation(async (key: unknown) => {
			if (typeof key === 'string') return { [key]: localStore.get(key) };
			return {};
		});
		vi.spyOn(browser.storage.local, 'set').mockImplementation(async (values: unknown) => {
			for (const [k, v] of Object.entries(values as Record<string, unknown>)) localStore.set(k, v);
			return undefined as never;
		});
		vi.spyOn(browser.storage.local, 'remove').mockImplementation(async (key: unknown) => {
			localStore.delete(String(key));
			return undefined as never;
		});
		await clearAiUsage();
	});

	test('fills in the fields the caller does not have and persists on flush', async () => {
		await recordAiUsage({ purpose: 'translate', model: 'deepseek-chat', promptTokens: 120.6, completionTokens: 30, segments: 4 });
		await flushUsage();

		const saved = localStore.get('ai_usage') as AiUsageEntry[];
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			model: 'deepseek-chat',
			purpose: 'translate',
			promptTokens: 121,          // rounded
			completionTokens: 30,
			segments: 4,
			estimated: false,
			durationMs: 0,
		});
		expect(saved[0].time).toBeGreaterThan(0);
	});

	test('newest first, and negative token counts never land', async () => {
		await recordAiUsage({ purpose: 'translate', model: 'a', time: NOW - 1000, promptTokens: 5 });
		await recordAiUsage({ purpose: 'translate', model: 'b', time: NOW, promptTokens: -50, completionTokens: -1 });
		await flushUsage();

		const saved = await getAiUsage();
		expect(saved.map(e => e.model)).toEqual(['b', 'a']);
		expect(saved[0]).toMatchObject({ promptTokens: 0, completionTokens: 0 });
	});

	test('clearing empties both memory and storage', async () => {
		await recordAiUsage({ purpose: 'test', model: 'a', promptTokens: 10 });
		await flushUsage();
		expect(localStore.get('ai_usage')).toHaveLength(1);

		await clearAiUsage();
		expect(await getAiUsage()).toEqual([]);
		expect(localStore.get('ai_usage')).toBeUndefined();
	});

	test('parallel batches all survive one shared load', async () => {
		await Promise.all(Array.from({ length: 12 }, (_unused, i) =>
			recordAiUsage({ purpose: 'translate', model: `model-${i}`, promptTokens: i + 1 })));
		await flushUsage();

		const saved = await getAiUsage();
		expect(saved).toHaveLength(12);
		expect(saved.reduce((sum, e) => sum + e.promptTokens, 0)).toBe(78);
	});

	test('entries older than the retention window are dropped on load', async () => {
		const now = Date.now();
		localStore.set('ai_usage', [
			entry({ time: now }),
			entry({ model: 'stale', time: now - 400 * DAY }),
		]);

		const loaded = await getAiUsage();
		expect(loaded).toHaveLength(1);
		expect(loaded[0].model).toBe('gpt-4o-mini');
	});
});
