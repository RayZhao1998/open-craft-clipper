import { describe, test, expect } from 'vitest';
import {
	buildCraftDocument,
	propertiesToCallouts,
	stripFrontmatter,
	buildSavedCaption,
	escapeLinkText,
} from './markdown';

const FIXED_DATE = new Date(2026, 6, 7, 14, 32); // Tue, 7 Jul 2026 14:32 local

describe('propertiesToCallouts', () => {
	test('renders one callout per non-empty property', () => {
		expect(propertiesToCallouts([
			{ name: 'source', value: '[Example](https://example.com)' },
			{ name: 'author', value: '' },
			{ name: 'tags', value: '  ' },
			{ name: 'draft', value: 'true' },
		])).toEqual([
			'<callout>**source**: [Example](https://example.com)</callout>',
			'<callout>**draft**: true</callout>',
		]);
	});

	test('checkbox booleans from the popup DOM do not crash and skip unchecked', () => {
		expect(propertiesToCallouts([
			{ name: 'starred', value: true as unknown as string },
			{ name: 'archived', value: false as unknown as string },
		])).toEqual([
			'<callout>**starred**: true</callout>',
		]);
	});
});

describe('stripFrontmatter', () => {
	test('removes a leading YAML block', () => {
		expect(stripFrontmatter('---\ntitle: x\n---\n\nBody')).toBe('\nBody');
	});

	test('leaves content that merely mentions --- alone', () => {
		expect(stripFrontmatter('Body\n\n---\n\nMore')).toBe('Body\n\n---\n\nMore');
	});
});

describe('buildSavedCaption', () => {
	test('uses a date:// link so the caption is clickable in Craft', () => {
		expect(buildSavedCaption(FIXED_DATE)).toBe('Saved [Tue, 7 Jul](date://2026-07-07) at 14:32');
	});
});

describe('escapeLinkText', () => {
	test('collapses newlines and escapes brackets', () => {
		expect(escapeLinkText('a\n b [c]')).toBe('a b \\[c\\]');
	});
});

describe('buildCraftDocument', () => {
	test('builds header callouts, tags, caption, divider and body', () => {
		const doc = buildCraftDocument({
			properties: [{ name: 'source', value: '[Example](https://example.com)' }],
			tags: '#clippings',
			body: '# Heading\n\nText',
			now: FIXED_DATE,
		});

		expect(doc).toBe([
			'<callout>**source**: [Example](https://example.com)</callout>',
			'',
			'<callout>#clippings</callout>',
			'',
			'<callout><caption>Saved [Tue, 7 Jul](date://2026-07-07) at 14:32</caption></callout>',
			'',
			'***',
			'',
			'# Heading',
			'',
			'Text',
		].join('\n'));
	});

	test('custom header replaces the property callouts', () => {
		const doc = buildCraftDocument({
			properties: [{ name: 'source', value: 'ignored' }],
			header: '<callout>My own header</callout>',
			body: 'Body',
			now: FIXED_DATE,
		});

		expect(doc).toContain('<callout>My own header</callout>');
		expect(doc).not.toContain('ignored');
	});

	test('strip mode drops properties but keeps the caption', () => {
		const doc = buildCraftDocument({
			properties: [{ name: 'source', value: 'gone' }],
			propertiesAs: 'strip',
			body: 'Body',
			now: FIXED_DATE,
		});

		expect(doc).not.toContain('gone');
		expect(doc).toContain('<caption>Saved');
	});

	test('empty tags and empty body do not leave stray blocks', () => {
		const doc = buildCraftDocument({ properties: [], tags: '   ', body: '  ', now: FIXED_DATE });
		expect(doc).toBe('<callout><caption>Saved [Tue, 7 Jul](date://2026-07-07) at 14:32</caption></callout>');
	});

	test('frontmatter in the body never reaches Craft', () => {
		const doc = buildCraftDocument({
			body: '---\ntitle: x\n---\n\nBody',
			properties: [],
			tags: '',
			now: FIXED_DATE,
		});

		expect(doc).not.toContain('title: x');
		expect(doc).toContain('Body');
	});

	test('multi-line tags become one callout per line', () => {
		const doc = buildCraftDocument({ body: 'b', properties: [], tags: '#a #b\n#c', now: FIXED_DATE });
		expect(doc).toContain('<callout>#a #b</callout>');
		expect(doc).toContain('<callout>#c</callout>');
	});
});
