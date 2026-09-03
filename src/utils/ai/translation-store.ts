// The persistent tier of the translation cache: paragraphs you have already
// paid to translate, kept so that re-opening an article costs nothing.
//
// Why IndexedDB rather than storage.local: this is the only collection in the
// extension that grows without a natural bound — one record per paragraph read.
// storage.local holds one JSON blob, so keeping it atomic means re-serializing
// every record ever stored on every write: saving one translation would get
// slower with everything read since installing. IDB writes one record per put,
// indexes time so expiry is a cursor instead of a rewrite, and its quota comes
// from free disk rather than the few megabytes an extension gets for
// storage.local without extra permissions.
//
// Only the background may build one of these. IndexedDB opened from a content
// script belongs to the *page* being translated — a different database, in
// somebody else's storage — so the store reaches the translation engine through
// `TranslateOptions.store`, which nothing outside background.ts ever passes.

import { debugLog } from '../debug';

export interface TranslationRecord {
	/** `translationCacheKey()`: endpoint + model + languages + prompt + source text. */
	key: string;
	/** The translation. */
	v: string;
	/** Stored size in characters (key + translation). The budget counts these. */
	s: number;
	/** Epoch milliseconds when it was written. Eviction is oldest-first on this. */
	t: number;
}

export interface TranslationBudget {
	maxEntries: number;
	/** Sum of `s` across the whole store, in characters. */
	maxChars: number;
	/** Older than this and it goes, whatever its rank. */
	ttlMs: number;
}

export const DEFAULT_TRANSLATION_BUDGET: TranslationBudget = {
	maxEntries: 40000,
	// Character count, not bytes: roughly a few thousand long articles' worth of
	// source and translation together.
	maxChars: 4000000,
	ttlMs: 90 * 24 * 60 * 60 * 1000
};

export interface TranslationStats {
	count: number;
	chars: number;
}

/**
 * The slice of IndexedDB this module uses, one method per transaction. Keeping
 * it this small is what makes the policy above testable without a browser: the
 * tests hand in an in-memory driver, and the IDB driver below is the only file
 * in here that touches `indexedDB`.
 */
export interface TranslationDriver {
	/**
	 * Rows for these keys, skipping any older than `notOlderThan`. Expiry has to
	 * hold on the read and not only in the sweep, or the first lookup after a
	 * two-month gap would still serve what it was supposed to have forgotten.
	 */
	lookup(keys: string[], notOlderThan: number): Promise<Record<string, string>>
	put(records: TranslationRecord[]): Promise<void>
	/** Drop expired entries, then trim to budget oldest-first. */
	sweep(budget: TranslationBudget, expiredBefore: number): Promise<void>
	stats(): Promise<TranslationStats>
	clear(): Promise<void>
}

/** How many records to write before checking the budget again. */
const SWEEP_EVERY = 64;

export interface TranslationStore {
	/** Keys found on disk. Never throws: a failed read looks like an empty cache. */
	lookup(keys: string[]): Promise<Record<string, string>>
	/** Fire-and-forget from the caller's point of view; failures are logged only. */
	record(values: Record<string, string>): Promise<void>
	stats(): Promise<TranslationStats>
	clear(): Promise<void>
}

/**
 * @param clock Injectable so the TTL tests do not need fake timers.
 */
export function createTranslationStore(
	driver: TranslationDriver,
	budget: TranslationBudget = DEFAULT_TRANSLATION_BUDGET,
	clock: () => number = () => Date.now()
): TranslationStore {
	let swept = false;
	let sinceSweep = 0;

	const sweep = async () => {
		try {
			await driver.sweep(budget, clock() - budget.ttlMs);
			sinceSweep = 0;
		} catch (error: unknown) {
			debugLog('TranslationStore', 'sweep failed:', error);
		}
	};

	return {
		async lookup(keys) {
			if (!keys.length) return {};
			// The first read of a session also clears what expired while the
			// extension was closed. It runs behind the answer, not in front of it.
			if (!swept) {
				swept = true;
				void sweep();
			}
			try {
				return await driver.lookup(keys, clock() - budget.ttlMs);
			} catch (error: unknown) {
				debugLog('TranslationStore', 'lookup failed:', error);
				return {};
			}
		},

		async record(values) {
			const now = clock();
			const records: TranslationRecord[] = [];
			for (const [key, value] of Object.entries(values)) {
				if (!key || typeof value !== 'string' || !value) continue;
				records.push({ key, v: value, s: key.length + value.length, t: now });
			}
			if (!records.length) return;

			try {
				await driver.put(records);
			} catch (error: unknown) {
				debugLog('TranslationStore', 'put failed:', error);
				return;
			}

			sinceSweep += records.length;
			if (sinceSweep >= SWEEP_EVERY) void sweep();
		},

		async stats() {
			try {
				return await driver.stats();
			} catch (error: unknown) {
				debugLog('TranslationStore', 'stats failed:', error);
				return { count: 0, chars: 0 };
			}
		},

		async clear() {
			sinceSweep = 0;
			try {
				await driver.clear();
			} catch (error: unknown) {
				debugLog('TranslationStore', 'clear failed:', error);
			}
		}
	};
}

// --- In-memory driver -------------------------------------------------------
// Tests and any context without IndexedDB. Same semantics as the IDB driver,
// including the eviction order, so the two cannot drift apart in behaviour.

export function createMemoryDriver(): TranslationDriver {
	const rows = new Map<string, TranslationRecord>();

	return {
		async lookup(keys, notOlderThan) {
			const found: Record<string, string> = {};
			for (const key of keys) {
				const row = rows.get(key);
				if (row && row.t >= notOlderThan) found[key] = row.v;
			}
			return found;
		},

		async put(records) {
			for (const record of records) rows.set(record.key, record);
		},

		async sweep(budget, expiredBefore) {
			for (const [key, row] of rows) {
				if (row.t < expiredBefore) rows.delete(key);
			}
			const total = () => Array.from(rows.values()).reduce((sum, row) => sum + row.s, 0);
			while (rows.size > budget.maxEntries || total() > budget.maxChars) {
				let oldest: string | null = null;
				for (const [key, row] of rows) {
					if (oldest === null || row.t < rows.get(oldest)!.t) oldest = key;
				}
				if (oldest === null) break;
				rows.delete(oldest);
			}
		},

		async stats() {
			return {
				count: rows.size,
				chars: Array.from(rows.values()).reduce((sum, row) => sum + row.s, 0)
			};
		},

		async clear() {
			rows.clear();
		}
	};
}

// --- IndexedDB driver -------------------------------------------------------

const DB_NAME = 'obsidian-clipper-translations';
const STORE = 'entries';
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				// `t` is indexed because both jobs that are not a point lookup —
				// expiring and trimming to budget — walk records oldest-first.
				db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('byTime', 't');
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('IndexedDB is blocked by another connection'));
	});
}

/**
 * One connection for the life of the worker. Opening per transaction would be
 * simpler but races with the worker being torn down mid-transaction; a held
 * connection also keeps upgrade costs to once.
 */
let connection: Promise<IDBDatabase> | null = null;

function connect(): Promise<IDBDatabase> {
	if (!connection) {
		connection = openDatabase().catch((error: unknown) => {
			// A failed open must not be remembered, or a browser that had the DB
			// locked for one request would lose the cache for the whole session.
			connection = null;
			throw error;
		});
	}
	return connection;
}

function done(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
	});
}

function read<T>(request: IDBRequest): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result as T);
		request.onerror = () => reject(request.error);
	});
}

export function createIndexedDbDriver(): TranslationDriver | null {
	if (typeof indexedDB === 'undefined') return null;

	return {
		async lookup(keys, notOlderThan) {
			const db = await connect();
			const transaction = db.transaction(STORE, 'readonly');
			const store = transaction.objectStore(STORE);
			const found: Record<string, string> = {};

			// One transaction for the whole batch: keys are looked up in the same
			// snapshot the request was built from, and the worker is not woken once
			// per paragraph.
			await Promise.all(keys.map(async (key) => {
				const record = await read<TranslationRecord | undefined>(store.get(key));
				if (record && typeof record.v === 'string' && record.t >= notOlderThan) found[key] = record.v;
			}));
			await done(transaction);
			return found;
		},

		async put(records) {
			const db = await connect();
			const transaction = db.transaction(STORE, 'readwrite');
			const store = transaction.objectStore(STORE);
			for (const record of records) store.put(record);
			await done(transaction);
		},

		async sweep(budget, expiredBefore) {
			const db = await connect();
			const transaction = db.transaction(STORE, 'readwrite');
			const store = transaction.objectStore(STORE);

			// Pass one: how much is in here. Trimming cannot be decided during an
			// oldest-first walk — by the time that walk reaches the newest rows, the
			// oldest are behind it, and the rows a budget gives up are exactly the ones
			// it has already walked past.
			let count = 0;
			let chars = 0;
			await new Promise<void>((resolve, reject) => {
				const cursor = store.index('byTime').openCursor();
				cursor.onsuccess = () => {
					const row = cursor.result;
					if (!row) return resolve();
					count++;
					chars += (row.value as TranslationRecord).s || 0;
					row.continue();
				};
				cursor.onerror = () => reject(cursor.error);
			});

			// Pass two, oldest-first: expiry and overflow both give up the same end of
			// the list, and the first row that is neither means nothing newer is either.
			let doomed = 0;
			await new Promise<void>((resolve, reject) => {
				const cursor = store.index('byTime').openCursor();
				cursor.onsuccess = () => {
					const row = cursor.result;
					if (!row) return resolve();
					const record = row.value as TranslationRecord;
					const expired = record.t < expiredBefore;
					const over = count > budget.maxEntries || chars > budget.maxChars;
					if (!expired && !over) return resolve();
					doomed++;
					count--;
					chars -= record.s || 0;
					row.delete();
					row.continue();
				};
				cursor.onerror = () => reject(cursor.error);
			});

			await done(transaction);
			if (doomed) debugLog('TranslationStore', 'dropped', doomed, 'stale translations');
		},

		async stats() {
			const db = await connect();
			const transaction = db.transaction(STORE, 'readonly');
			const store = transaction.objectStore(STORE);
			const count = await read<number>(store.count());

			let chars = 0;
			await new Promise<void>((resolve, reject) => {
				const cursor = store.openCursor();
				cursor.onsuccess = () => {
					const row = cursor.result;
					if (!row) return resolve();
					chars += (row.value as TranslationRecord).s || 0;
					row.continue();
				};
				cursor.onerror = () => reject(cursor.error);
			});
			await done(transaction);
			return { count, chars };
		},

		async clear() {
			const db = await connect();
			const transaction = db.transaction(STORE, 'readwrite');
			transaction.objectStore(STORE).clear();
			await done(transaction);
		}
	};
}

// --- The one the background uses --------------------------------------------

let store: TranslationStore | null | undefined;

/**
 * The shared store, or null when this context has no IndexedDB. Null rather
 * than a throwing object so callers can keep asking: no persistence is the
 * behaviour the extension had before, and translation must not depend on it.
 */
export function getTranslationStore(): TranslationStore | null {
	if (store === undefined) {
		const driver = createIndexedDbDriver();
		store = driver ? createTranslationStore(driver) : null;
	}
	return store;
}

/** Tests only: forget the shared store. */
export function resetTranslationStore(): void {
	store = undefined;
}
