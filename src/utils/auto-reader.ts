import browser from './browser-polyfill';

/**
 * "Open Reader automatically on these pages" — the rule list a user types in
 * Settings → Reader, evaluated in the background on every top-frame navigation.
 *
 * This module is policy only: it decides whether an address should open in
 * Reader, and remembers the tabs where the user said "not here" by switching
 * Reader off by hand. Injecting and toggling stays in background.ts.
 */

export interface AutoReaderRule {
	/** What the user typed, kept for debugging. */
	raw: string;
	/** `-` (or `!`) prefix: carve this out of the broader rules. */
	negate: boolean;
	/** `/…/` form, tested against the whole URL. */
	regex?: RegExp;
	/** Host form: matches this host and any subdomain of it. */
	host?: string;
	/** Path a host rule is limited to, e.g. `/blog`. Empty means any path. */
	pathPrefix?: string;
	/** `http(s)://…` form: plain prefix of the whole URL. */
	urlPrefix?: string;
}

export interface AutoReaderConfig {
	enabled: boolean;
	rules: AutoReaderRule[];
}

export const autoReaderDisabled: AutoReaderConfig = { enabled: false, rules: [] };

/**
 * Storage is user-editable, so a pattern list can be anything — a number, an
 * unterminated regex, a lone `-`. Anything unusable is dropped rather than
 * throwing, because one bad line must not disable the whole feature.
 */
export function parseAutoReaderPatterns(patterns: unknown): AutoReaderRule[] {
	if (!Array.isArray(patterns)) return [];

	const rules: AutoReaderRule[] = [];
	for (const entry of patterns) {
		const rule = parsePattern(entry);
		if (rule) rules.push(rule);
	}
	return rules;
}

function parsePattern(entry: unknown): AutoReaderRule | null {
	if (typeof entry !== 'string') return null;

	const raw = entry.trim();
	if (!raw || raw.startsWith('#')) return null;

	let text = raw;
	let negate = false;
	if (text.startsWith('-') || text.startsWith('!')) {
		negate = true;
		text = text.slice(1).trim();
	}
	if (!text) return null;

	if (text.length > 2 && text.startsWith('/') && text.endsWith('/')) {
		try {
			return { raw, negate, regex: new RegExp(text.slice(1, -1), 'i') };
		} catch {
			console.warn('[Auto Reader] ignoring invalid regex pattern:', raw);
			return null;
		}
	}

	// Already a full address — match it as a prefix of the URL.
	if (/^https?:\/\//i.test(text)) {
		return { raw, negate, urlPrefix: text.toLowerCase() };
	}

	const slash = text.indexOf('/');
	const host = (slash === -1 ? text : text.slice(0, slash))
		.toLowerCase()
		.replace(/^www\./, '')
		.replace(/\.$/, '');
	if (!host || /\s/.test(host)) return null;

	// A path is stored without its trailing slash, so `example.com/blog` and
	// `example.com/blog/` mean the same thing, and `example.com/` is host-only.
	let pathPrefix = slash === -1 ? '' : text.slice(slash);
	if (pathPrefix === '/') pathPrefix = '';
	else if (pathPrefix.length > 1 && pathPrefix.endsWith('/')) pathPrefix = pathPrefix.slice(0, -1);

	return { raw, negate, host, pathPrefix };
}

function parseHttpUrl(url: unknown): URL | null {
	if (typeof url !== 'string') return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
	} catch {
		return null;
	}
}

function ruleMatches(rule: AutoReaderRule, url: URL, href: string): boolean {
	if (rule.regex) return rule.regex.test(href);

	if (rule.urlPrefix) return href.toLowerCase().startsWith(rule.urlPrefix);

	if (!rule.host) return false;
	// A rule may carry a port (`localhost:3000`); without one, the port is ignored.
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	const hostAndPort = url.host.toLowerCase();
	const matches = (candidate: string) => candidate === rule.host || candidate.endsWith('.' + rule.host);
	if (!matches(host) && !matches(hostAndPort)) return false;

	if (rule.pathPrefix) {
		// Path boundaries count: `example.com/blog` covers `/blog` and `/blog/x`,
		// but not `/bloggers`. The query is included so `…/item?id=42` is usable.
		const pathname = url.pathname.startsWith('/') ? url.pathname : '/' + url.pathname;
		const target = pathname + url.search;
		if (target !== rule.pathPrefix && !target.startsWith(rule.pathPrefix + '/')) return false;
	}

	return true;
}

/**
 * True when the address should open in Reader. Exceptions win wherever they
 * appear in the list, so an exclusion never depends on rule order.
 */
export function shouldAutoReader(config: AutoReaderConfig | null | undefined, url: unknown): boolean {
	if (!config?.enabled || !Array.isArray(config.rules) || config.rules.length === 0) return false;

	const parsed = parseHttpUrl(url);
	if (!parsed) return false;

	let matched = false;
	for (const rule of config.rules) {
		if (!rule || typeof rule !== 'object') continue;
		if (!ruleMatches(rule, parsed, parsed.href)) continue;
		if (rule.negate) return false;
		matched = true;
	}
	return matched;
}

// --- Config cache -----------------------------------------------------------
// tabs.onUpdated fires for every page in every window, so the rule list is
// read once and refreshed when the storage it lives in changes.

let cachedConfig: AutoReaderConfig | null = null;

export async function getAutoReaderConfig(): Promise<AutoReaderConfig> {
	if (cachedConfig) return cachedConfig;

	try {
		const data = await browser.storage.sync.get('reader_settings') as Record<string, unknown>;
		const stored = data?.reader_settings as Record<string, unknown> | undefined;
		// Only cached on success: a failed read should be retried on the next
		// navigation rather than disabling the feature for the whole session.
		cachedConfig = {
			enabled: stored?.autoReaderEnabled === true,
			rules: parseAutoReaderPatterns(stored?.autoReaderPatterns),
		};
		return cachedConfig;
	} catch (error) {
		console.warn('[Auto Reader] could not read settings:', error);
		return autoReaderDisabled;
	}
}

export function invalidateAutoReaderConfig(): void {
	cachedConfig = null;
}

// --- Manual opt-out ---------------------------------------------------------
// Turning Reader off reloads the page, and the MV3 service worker can be
// stopped between the toggle and that reload, so the tab list is mirrored into
// storage.local — otherwise the page would be pushed straight back into the
// view the user just left.

const SUPPRESSED_TABS_KEY = 'auto_reader_suppressed_tabs';

let suppressedTabs = new Set<number>();
let suppressionLoad: Promise<Set<number>> | null = null;

async function loadSuppressedTabs(): Promise<Set<number>> {
	if (!suppressionLoad) {
		suppressionLoad = (async () => {
			try {
				const stored = await browser.storage.local.get(SUPPRESSED_TABS_KEY) as Record<string, unknown>;
				const raw = stored?.[SUPPRESSED_TABS_KEY];
				if (Array.isArray(raw)) {
					for (const id of raw) {
						if (typeof id === 'number') suppressedTabs.add(id);
					}
				}
			} catch {
				// Memory only — a fresh session simply starts unsuppressed.
			}
			return suppressedTabs;
		})();
	}
	return suppressionLoad;
}

async function persistSuppressedTabs(): Promise<void> {
	try {
		await browser.storage.local.set({ [SUPPRESSED_TABS_KEY]: [...suppressedTabs] });
	} catch {
		// In-memory suppression still covers the current session.
	}
}

export async function suppressAutoReader(tabId: number): Promise<void> {
	// Added before the mirror is read back: turning Reader off reloads the page,
	// and the opt-out has to be in place before that load reports back.
	suppressedTabs.add(tabId);
	await loadSuppressedTabs();
	await persistSuppressedTabs();
}

export async function isAutoReaderSuppressed(tabId: number): Promise<boolean> {
	return (await loadSuppressedTabs()).has(tabId);
}

export function clearAutoReaderSuppression(tabId: number): void {
	if (!suppressedTabs.delete(tabId)) return;
	void persistSuppressedTabs();
}
