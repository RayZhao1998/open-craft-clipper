import { describe, test, expect } from 'vitest';
import {
	adaptMarkdownForCraft,
	convertWikiLinks,
	convertCallouts,
	convertHighlights,
	removeComments,
	absolutizeImages,
	resolveWikiLink,
} from './syntax';

const BASE = 'https://example.com/posts/article.html';

describe('convertWikiLinks', () => {
	test('renders plain text by default', () => {
		expect(convertWikiLinks('See [[Another note]] and [[Another|the other one]].')).toBe(
			'See Another note and the other one.'
		);
	});

	test('resolves headings', () => {
		expect(convertWikiLinks('[[#Getting started]]')).toBe('Getting started');
		expect(convertWikiLinks('[[Concept#Usage]]')).toBe('Concept → Usage');
	});

	test('link mode points at an Obsidian search', () => {
		expect(resolveWikiLink('Concept', { wikilinks: 'link', vault: 'My Vault' }))
			.toBe('[Concept](obsidian://search?vault=My+Vault&query=Concept)');
	});

	test('embeds become images only when the URL can be resolved', () => {
		expect(convertWikiLinks('Intro\n![[diagram.png]]\nOutro', { baseUrl: BASE }))
			.toBe('Intro\n![diagram.png](https://example.com/posts/diagram.png)\nOutro');
		expect(convertWikiLinks('![[diagram.png]]')).toBe('');
	});

	test('note transclusions are dropped — Craft cannot embed notes', () => {
		expect(convertWikiLinks('Before\n![[Other note]]\nAfter')).toBe('Before\n\nAfter');
	});

	test('leaves code alone', () => {
		const md = 'Use [[wikilinks]] like this:\n\n```md\nlink with [[StillIntact]]\n```\n\nAnd `[[AlsoIntact]]` here.';
		expect(convertWikiLinks(md)).toBe(
			'Use wikilinks like this:\n\n```md\nlink with [[StillIntact]]\n```\n\nAnd `[[AlsoIntact]]` here.'
		);
	});
});

describe('convertCallouts', () => {
	test('keeps the title and body in one callout', () => {
		expect(convertCallouts('> [!tip] Heads up\n> First line\n> Second line'))
			.toBe('<callout>Heads up\n\nFirst line\nSecond line</callout>\n');
	});

	test('names unlabelled callouts after their type', () => {
		expect(convertCallouts('> [!warning]\n> Careful')).toBe('<callout>Warning\n\nCareful</callout>\n');
	});

	test('keeps unknown/custom callout types as-is', () => {
		expect(convertCallouts('> [!coffeescript]\n> Buy me a coffee'))
			.toBe('<callout>coffeescript\n\nBuy me a coffee</callout>\n');
	});

	test('does not touch callout syntax shown inside a code block', () => {
		const md = '```md\n> [!tip] Example callout\n> body\n```';
		expect(convertCallouts(md)).toBe(md);
	});
});

describe('removeComments', () => {
	test('removes inline and multi-line comments', () => {
		expect(removeComments('a %% hidden %% b')).toBe('a b');
		expect(removeComments('a\n%%\nhidden\n%%\nb')).toBe('a\n\nb');
	});

	test('keeps comment markers inside code', () => {
		const md = '```\n%% not a comment %%\n```';
		expect(removeComments(md)).toBe(md);
	});
});

describe('convertHighlights', () => {
	test('turns highlights bold, but not inside code', () => {
		expect(convertHighlights('This is ==important== and `==not==`')).toBe('This is **important** and `==not==`');
	});
});

describe('absolutizeImages', () => {
	test('resolves relative markdown and html images', () => {
		const md = '![a](/img/a.png) and <img src="./b.png" width="20">';
		expect(absolutizeImages(md, BASE))
			.toBe('![a](https://example.com/img/a.png) and <img src="https://example.com/posts/b.png" width="20">');
	});

	test('leaves absolute and data URLs alone', () => {
		const md = '![a](https://cdn.test/a.png) ![b](data:image/png;base64,AAA)';
		expect(absolutizeImages(md, BASE)).toBe(md);
	});

	test('is a no-op without a base URL', () => {
		expect(absolutizeImages('![a](/img/a.png)')).toBe('![a](/img/a.png)');
	});
});

describe('adaptMarkdownForCraft', () => {
	test('combines the conversions for a realistic clipping', () => {
		const source = [
			'%% private note %%',
			'This links to [[Concept|a concept]] with ==emphasis==.',
			'',
			'> [!quote] "A quote"',
			'> — Someone',
			'',
			'![Figure](/img/figure.png)',
			'',
			'```js',
			'const link = "[[Concept]]";',
			'```',
		].join('\n');

		const result = adaptMarkdownForCraft(source, { baseUrl: BASE });

		expect(result).toContain('This links to a concept with **emphasis**.');
		expect(result).toContain('<callout>"A quote"\n\n— Someone</callout>');
		expect(result).toContain('![Figure](https://example.com/img/figure.png)');
		expect(result).toContain('const link = "[[Concept]]";');
		expect(result).not.toContain('private note');
		// Outside the code sample there must be no Obsidian-only syntax left.
		expect(result.split('```')[0]).not.toContain('[[');
		expect(result.split('```')[0]).not.toContain('> [!');
	});
});
