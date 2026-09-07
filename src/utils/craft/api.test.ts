import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	appendMarkdown,
	createDocumentWithMarkdown,
	normalizeApiUrl,
	maskSecretLink,
	splitIntoBlocks,
	splitMarkdownIntoChunks,
} from './api';

const byteLength = (s: string) => new TextEncoder().encode(s).length;

describe('normalizeApiUrl', () => {
	test('accepts a full API URL', () => {
		expect(normalizeApiUrl('https://connect.craft.do/links/abc123/api/v1'))
			.toBe('https://connect.craft.do/links/abc123/api/v1');
	});

	test('upgrades a share link and strips trailing slashes', () => {
		expect(normalizeApiUrl('https://connect.craft.do/links/abc123///'))
			.toBe('https://connect.craft.do/links/abc123/api/v1');
	});

	test('accepts a bare link id', () => {
		expect(normalizeApiUrl('  abc_123-DEF  '))
			.toBe('https://connect.craft.do/links/abc_123-DEF/api/v1');
	});

	test('supports an alternative connect host', () => {
		expect(normalizeApiUrl('https://connect.example.com/links/xyz', 'https://connect.example.com'))
			.toBe('https://connect.example.com/links/xyz/api/v1');
	});

	test('rejects empty and unrelated input', () => {
		expect(() => normalizeApiUrl('   ')).toThrow();
		expect(() => normalizeApiUrl('https://evil.example/links/abc')).toThrow();
		expect(() => normalizeApiUrl('not an id!')).toThrow();
	});
});

describe('maskSecretLink', () => {
	test('redacts the link id but keeps a recognisable prefix', () => {
		expect(maskSecretLink('https://connect.craft.do/links/supersecretid/api/v1'))
			.toBe('https://connect.craft.do/links/supe****/api/v1');
	});

	test('leaves unrelated text alone', () => {
		expect(maskSecretLink('Craft API request failed (500).')).toBe('Craft API request failed (500).');
	});
});

describe('splitIntoBlocks', () => {
	test('splits on blank lines and collapses runs of blanks', () => {
		expect(splitIntoBlocks('a\n\n\nb\n\nc')).toEqual(['a', 'b', 'c']);
	});

	test('keeps a fenced code block containing blank lines in one block', () => {
		expect(splitIntoBlocks('before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter'))
			.toEqual(['before', '```js\nconst a = 1;\n\nconst b = 2;\n```', 'after']);
	});
});

describe('splitMarkdownIntoChunks', () => {
	test('returns a single chunk when under the limit', () => {
		expect(splitMarkdownIntoChunks('a\n\nb', 1000)).toEqual(['a\n\nb']);
	});

	test('splits at block boundaries and never exceeds the limit', () => {
		const blocks = Array.from({ length: 20 }, (_, i) => `block ${i} ${'x'.repeat(50)}`);
		const markdown = blocks.join('\n\n');
		const chunks = splitMarkdownIntoChunks(markdown, 300);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(byteLength(chunk)).toBeLessThanOrEqual(300);
		}
		// Nothing lost or reordered: rejoining reproduces the original blocks.
		expect(chunks.join('\n\n').split('\n\n')).toEqual(blocks);
	});

	test('an oversized single block is passed through rather than cut mid-fence', () => {
		const code = '```python\n' + 'print(1)\n'.repeat(200) + '```';
		const chunks = splitMarkdownIntoChunks(code, 100);
		expect(chunks).toEqual([code]);
	});
});

describe('appendMarkdown', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('throws when POST /blocks returns an empty 200 body', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => '',
		})));

		await expect(appendMarkdown('https://connect.craft.do/links/test/api/v1', 'doc-1', 'Hello'))
			.rejects.toThrow('Craft did not confirm the content was saved.');
	});
});

describe('createDocumentWithMarkdown', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('trashes the document when writing the body fails', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const path = String(url);
			const method = init?.method || 'GET';
			if (method === 'POST' && path.endsWith('/documents')) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ items: [{ id: 'doc-1', title: 'A clip' }] }),
				};
			}
			if (method === 'POST' && path.endsWith('/blocks')) {
				return {
					ok: false,
					status: 400,
					text: async () => JSON.stringify({ message: 'Expected inline markdown, got image' }),
				};
			}
			if (method === 'DELETE' && path.endsWith('/documents')) {
				return { ok: true, status: 200, text: async () => '{}' };
			}
			return { ok: false, status: 500, text: async () => '' };
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(createDocumentWithMarkdown(
			'https://connect.craft.do/links/test/api/v1',
			'A clip',
			'Hello ![x](https://ex.com/x.png) world',
			null
		)).rejects.toThrow('Expected inline markdown, got image');

		const methods = fetchMock.mock.calls.map(([url, init]) => [
			(init as RequestInit | undefined)?.method || 'GET',
			String(url).replace(/^.*\/api\/v1/, ''),
		]);
		expect(methods).toEqual([
			['POST', '/documents'],
			['POST', '/blocks'],
			['DELETE', '/documents'],
		]);
		const deleteBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
		expect(deleteBody).toEqual({ documentIds: ['doc-1'] });
	});
});
