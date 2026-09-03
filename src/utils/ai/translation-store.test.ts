import { describe, expect, test, vi } from 'vitest';
import {
	DEFAULT_TRANSLATION_BUDGET,
	createMemoryDriver,
	createTranslationStore,
	type TranslationBudget,
	type TranslationDriver
} from './translation-store';

const DAY = 24 * 60 * 60 * 1000;
const START = 1_700_000_000_000;

function budget(overrides: Partial<TranslationBudget> = {}): TranslationBudget {
	return { ...DEFAULT_TRANSLATION_BUDGET, ...overrides };
}

describe('translation store', () => {
	test('round-trips what it was given', async () => {
		const store = createTranslationStore(createMemoryDriver());
		await store.record({ keyA: 'uno', keyB: 'dos' });

		await expect(store.lookup(['keyA', 'keyB', 'keyMissing'])).resolves.toEqual({ keyA: 'uno', keyB: 'dos' });
	});

	test('keeps junk out: empty results and values that are not strings', async () => {
		const store = createTranslationStore(createMemoryDriver());
		await store.record({ ok: 'translation', blank: '', count: 3 as unknown as string });

		await expect(store.lookup(['ok', 'blank', 'count'])).resolves.toEqual({ ok: 'translation' });
	});

	test('an expired entry is not served, even before the sweep reaches it', async () => {
		let now = START;
		const store = createTranslationStore(createMemoryDriver(), budget({ ttlMs: 30 * DAY }), () => now);
		await store.record({ paragraph: 'translation' });
		now += 40 * DAY;

		// A two-month gap between readings must not resurrect what expiry decided
		// to forget; the sweep runs behind the answer, not in front of it.
		await expect(store.lookup(['paragraph'])).resolves.toEqual({});
	});

	test('the sweep deletes expired rows rather than hiding them', async () => {
		let now = START;
		const driver = createMemoryDriver();
		const rules = budget({ ttlMs: 30 * DAY });
		const store = createTranslationStore(driver, rules, () => now);
		await store.record({ old: 'one' });
		now += 10 * DAY;
		await store.record({ fresh: 'two' });

		// 35 days on: the first paragraph is past the 30-day line, the second is 25
		// days old and stays.
		now += 25 * DAY;
		await driver.sweep(rules, now - rules.ttlMs);

		expect(await driver.stats()).toMatchObject({ count: 1 });
		await expect(store.lookup(['old', 'fresh'])).resolves.toEqual({ fresh: 'two' });
	});

	test('the entry budget drops the oldest first', async () => {
		let now = START;
		const driver = createMemoryDriver();
		const rules = budget({ maxEntries: 3 });
		const store = createTranslationStore(driver, rules, () => now);

		for (let i = 0; i < 5; i++) {
			await store.record({ ['paragraph-' + i]: 'translation' });
			now += 1000;
		}
		await driver.sweep(rules, now - rules.ttlMs);

		await expect(store.lookup(['paragraph-0', 'paragraph-1', 'paragraph-2', 'paragraph-3', 'paragraph-4']))
			.resolves.toEqual({ 'paragraph-2': 'translation', 'paragraph-3': 'translation', 'paragraph-4': 'translation' });
	});

	test('the character budget trims from the same end', async () => {
		let now = START;
		const driver = createMemoryDriver();
		// Each record stores key + value = 13 characters, so two fit and a third does not.
		const rules = budget({ maxChars: 30 });
		const store = createTranslationStore(driver, rules, () => now);

		for (let i = 0; i < 5; i++) {
			await store.record({ ['p-' + i]: 'x'.repeat(10) });
			now += 1000;
		}
		await driver.sweep(rules, now - rules.ttlMs);

		expect((await driver.stats()).chars).toBeLessThanOrEqual(rules.maxChars);
		expect((await driver.stats()).count).toBe(2);
	});

	test('reports what is stored, in the unit the budget counts', async () => {
		const store = createTranslationStore(createMemoryDriver());
		await store.record({ ab: 'cd' });      // 4 characters
		await store.record({ ef: 'ghij' });    // 6 characters

		expect(await store.stats()).toEqual({ count: 2, chars: 10 });
	});

	test('clearing empties it', async () => {
		const store = createTranslationStore(createMemoryDriver());
		await store.record({ a: 'one', b: 'two' });

		await store.clear();

		expect(await store.stats()).toEqual({ count: 0, chars: 0 });
		await expect(store.lookup(['a', 'b'])).resolves.toEqual({});
	});

	test('a broken database costs the next read, not this translation', async () => {
		const broken: TranslationDriver = {
			lookup: vi.fn().mockRejectedValue(new Error('quota exceeded')),
			put: vi.fn().mockRejectedValue(new Error('quota exceeded')),
			sweep: vi.fn().mockRejectedValue(new Error('closed')),
			stats: vi.fn().mockRejectedValue(new Error('closed')),
			clear: vi.fn().mockRejectedValue(new Error('closed'))
		};
		const store = createTranslationStore(broken);

		// Every one of these is on the path of a translation the user asked for.
		await expect(store.lookup(['k'])).resolves.toEqual({});
		await expect(store.record({ k: 'v' })).resolves.toBeUndefined();
		expect(await store.stats()).toEqual({ count: 0, chars: 0 });
		await expect(store.clear()).resolves.toBeUndefined();
	});

	test('the budget is checked in batches, not on every write', async () => {
		const driver = createMemoryDriver();
		const sweep = vi.spyOn(driver, 'sweep');
		const store = createTranslationStore(driver);

		for (let i = 0; i < 63; i++) await store.record({ ['k' + i]: 'v' });
		// First lookup sweeps once; that is the only check so far.
		await store.lookup(['k0']);
		expect(sweep).toHaveBeenCalledTimes(1);

		for (let i = 63; i < 130; i++) await store.record({ ['k' + i]: 'v' });
		expect(sweep.mock.calls.length).toBeGreaterThan(1);
	});
});
