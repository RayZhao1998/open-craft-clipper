import { describe, test, expect, beforeEach, vi } from 'vitest';
import browser from './browser-polyfill';
import {
	parseAutoReaderPatterns,
	shouldAutoReader,
	getAutoReaderConfig,
	invalidateAutoReaderConfig,
	suppressAutoReader,
	isAutoReaderSuppressed,
	clearAutoReaderSuppression,
	AutoReaderConfig,
} from './auto-reader';

function config(...patterns: string[]): AutoReaderConfig {
	return { enabled: true, rules: parseAutoReaderPatterns(patterns) };
}

describe('parseAutoReaderPatterns', () => {
	test('keeps usable patterns and drops blanks, comments and junk', () => {
		const rules = parseAutoReaderPatterns([
			'', '   ', '# a comment', 42, null, {},
			'example.com',
			'-example.com/comments',
			'/^https:\\/\\/x\\.example\\.com\\/article\\/\\d+$/',
			'https://example.com/2024/',
			'-',
			'/[unclosed/',
		]);

		expect(rules.map(r => r.raw)).toEqual([
			'example.com',
			'-example.com/comments',
			'/^https:\\/\\/x\\.example\\.com\\/article\\/\\d+$/',
			'https://example.com/2024/',
		]);
	});

	test('splits a host rule into host and path prefix', () => {
		const [rule] = parseAutoReaderPatterns(['www.Example.com/Blog/Post']);
		expect(rule).toMatchObject({ host: 'example.com', pathPrefix: '/Blog/Post', negate: false });
	});

	test('marks exclusions from a leading - or !', () => {
		const rules = parseAutoReaderPatterns(['-a.com', '!b.com']);
		expect(rules.map(r => r.negate)).toEqual([true, true]);
		expect(rules.map(r => r.host)).toEqual(['a.com', 'b.com']);
	});
});

describe('shouldAutoReader', () => {
	test('a bare domain matches that host and its subdomains, not look-alikes', () => {
		const rules = config('example.com');
		expect(shouldAutoReader(rules, 'https://example.com/post')).toBe(true);
		expect(shouldAutoReader(rules, 'https://www.example.com/')).toBe(true);
		expect(shouldAutoReader(rules, 'https://deep.news.example.com/a/b')).toBe(true);
		expect(shouldAutoReader(rules, 'http://example.com')).toBe(true);

		// A shared suffix is not the same host.
		expect(shouldAutoReader(rules, 'https://notexample.com/')).toBe(false);
		expect(shouldAutoReader(rules, 'https://evil-example.com/')).toBe(false);
		expect(shouldAutoReader(rules, 'https://example.com.evil.org/')).toBe(false);
	});

	test('a path narrows a host rule to that path and its children', () => {
		const rules = config('example.com/blog/');
		expect(shouldAutoReader(rules, 'https://example.com/blog/post-1')).toBe(true);
		expect(shouldAutoReader(rules, 'https://example.com/blog')).toBe(true);
		expect(shouldAutoReader(rules, 'https://example.com/about')).toBe(false);

		// The rule ends at a path boundary, so a longer word is not a match.
		const exact = config('example.com/blog');
		expect(shouldAutoReader(exact, 'https://example.com/bloggers')).toBe(false);
		expect(shouldAutoReader(exact, 'https://example.com/blog/2024')).toBe(true);
	});

	test('a rule may carry a query and a bare slash is host-only', () => {
		expect(shouldAutoReader(config('news.example.com/item?id=42'), 'https://news.example.com/item?id=42')).toBe(true);
		expect(shouldAutoReader(config('news.example.com/item?id=42'), 'https://news.example.com/item?id=43')).toBe(false);
		expect(shouldAutoReader(config('example.com/'), 'https://example.com/anything')).toBe(true);
	});

	test('query and hash do not affect a host rule', () => {
		const rules = config('example.com');
		expect(shouldAutoReader(rules, 'https://example.com/search?q=1')).toBe(true);
		expect(shouldAutoReader(rules, 'https://example.com/#top')).toBe(true);
	});

	test('a full address is matched as a prefix', () => {
		const rules = config('https://example.com/2024/');
		expect(shouldAutoReader(rules, 'https://example.com/2024/deep-link')).toBe(true);
		expect(shouldAutoReader(rules, 'https://example.com/2023/')).toBe(false);
		// Prefix rules are about the address, so the host shortcut does not apply.
		expect(shouldAutoReader(rules, 'https://www.example.com/2024/deep-link')).toBe(false);
	});

	test('a /regex/ rule is tested against the whole URL', () => {
		const rules = config('/^https:\\/\\/news\\.example\\.com\\/item\\?id=\\d+$/');
		expect(shouldAutoReader(rules, 'https://news.example.com/item?id=42')).toBe(true);
		expect(shouldAutoReader(rules, 'https://news.example.com/item?id=abc')).toBe(false);
	});

	test('a rule may carry a port, and a rule without one ignores the port', () => {
		expect(shouldAutoReader(config('localhost:3000'), 'http://localhost:3000/draft')).toBe(true);
		expect(shouldAutoReader(config('localhost:3000'), 'http://localhost:4000/draft')).toBe(false);
		expect(shouldAutoReader(config('example.com'), 'http://example.com:8080/post')).toBe(true);
	});

	test('a * covers one path segment and ** any depth', () => {
		const status = config('x.com/*/status/*');
		expect(shouldAutoReader(status, 'https://x.com/philipkiely/status/2094916428076106029')).toBe(true);
		expect(shouldAutoReader(status, 'https://x.com/philipkiely/status/2094916428076106029?s=20&t=a')).toBe(true);
		expect(shouldAutoReader(status, 'https://www.x.com/philipkiely/status/2094916428076106029/photo/1')).toBe(true);

		// The timeline, bookmarks and the web-status route are not status pages
		// in this shape; ** is what spans separators.
		expect(shouldAutoReader(status, 'https://x.com/home')).toBe(false);
		expect(shouldAutoReader(status, 'https://x.com/i/bookmarks')).toBe(false);
		expect(shouldAutoReader(status, 'https://x.com/i/web/status/2094916428076106029')).toBe(false);
		expect(shouldAutoReader(config('x.com/**/status/*'), 'https://x.com/i/web/status/2094916428076106029')).toBe(true);
	});

	test('a ^ pattern is a regex on the whole address, slashes unescaped', () => {
		const rules = config('^https://(www\\.)?x\\.com/[^/]+/status/\\d+$');
		expect(shouldAutoReader(rules, 'https://x.com/philipkiely/status/2094916428076106029')).toBe(true);
		expect(shouldAutoReader(rules, 'https://x.com/philipkiely/status/abc')).toBe(false);
		expect(shouldAutoReader(rules, 'https://x.com/philipkiely/status/123?s=20')).toBe(false);
	});

	test('wildcards and exceptions combine', () => {
		const rules = config('x.com/**/status/*', '-x.com/*/status/*/video');
		expect(shouldAutoReader(rules, 'https://x.com/a/status/1')).toBe(true);
		expect(shouldAutoReader(rules, 'https://x.com/a/status/1/video')).toBe(false);
	});

	test('exclusions win whatever their position in the list', () => {
		const after = config('example.com', '-example.com/comments');
		const before = config('-example.com/comments', 'example.com');
		expect(shouldAutoReader(after, 'https://example.com/post')).toBe(true);
		expect(shouldAutoReader(after, 'https://example.com/comments/1')).toBe(false);
		expect(shouldAutoReader(before, 'https://example.com/comments/1')).toBe(false);
	});

	test('an exclusion alone never opens Reader', () => {
		expect(shouldAutoReader(config('-example.com'), 'https://example.com/post')).toBe(false);
	});

	test('nothing matches while the feature is off or the list is empty', () => {
		expect(shouldAutoReader({ enabled: false, rules: parseAutoReaderPatterns(['example.com']) }, 'https://example.com/')).toBe(false);
		expect(shouldAutoReader({ enabled: true, rules: [] }, 'https://example.com/')).toBe(false);
		expect(shouldAutoReader(null, 'https://example.com/')).toBe(false);
	});

	test('only http(s) addresses can match', () => {
		const rules = config('example.com');
		expect(shouldAutoReader(rules, 'file:///tmp/example.com/index.html')).toBe(false);
		expect(shouldAutoReader(rules, 'chrome://extensions')).toBe(false);
		expect(shouldAutoReader(rules, 'javascript:void(0)')).toBe(false);
		expect(shouldAutoReader(rules, 'not a url')).toBe(false);
		expect(shouldAutoReader(rules, undefined)).toBe(false);
	});
});

describe('getAutoReaderConfig', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		invalidateAutoReaderConfig();
	});

	test('reads the rule list out of reader settings', async () => {
		const get = vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			reader_settings: { autoReaderEnabled: true, autoReaderPatterns: ['example.com', '-example.com/comments'] },
		} as never);

		const cfg = await getAutoReaderConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.rules).toHaveLength(2);
		expect(shouldAutoReader(cfg, 'https://example.com/post')).toBe(true);
		expect(shouldAutoReader(cfg, 'https://example.com/comments/1')).toBe(false);

		get.mockRestore();
	});

	test('is cached until invalidated', async () => {
		const get = vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			reader_settings: { autoReaderEnabled: true, autoReaderPatterns: ['example.com'] },
		} as never);

		await getAutoReaderConfig();
		await getAutoReaderConfig();
		expect(get).toHaveBeenCalledTimes(1);

		invalidateAutoReaderConfig();
		await getAutoReaderConfig();
		expect(get).toHaveBeenCalledTimes(2);

		get.mockRestore();
	});

	test('a storage read failure does not disable the rest of the session', async () => {
		const get = vi.spyOn(browser.storage.sync, 'get').mockRejectedValueOnce(new Error('unavailable'));
		expect((await getAutoReaderConfig()).enabled).toBe(false);

		get.mockResolvedValue({ reader_settings: { autoReaderEnabled: true, autoReaderPatterns: ['example.com'] } } as never);
		expect((await getAutoReaderConfig()).enabled).toBe(true);

		get.mockRestore();
	});
});

describe('manual opt-out', () => {
	const localStore = new Map<string, unknown>();

	beforeEach(() => {
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
	});

	test('a tab that turned Reader off stays off until it moves on', async () => {
		await suppressAutoReader(7);
		expect(await isAutoReaderSuppressed(7)).toBe(true);
		expect(await isAutoReaderSuppressed(8)).toBe(false);

		clearAutoReaderSuppression(7);
		expect(await isAutoReaderSuppressed(7)).toBe(false);
	});

	test('the opt-out is mirrored into storage so a service worker restart keeps it', async () => {
		await suppressAutoReader(9);
		expect(localStore.get('auto_reader_suppressed_tabs')).toEqual([9]);
	});
});
