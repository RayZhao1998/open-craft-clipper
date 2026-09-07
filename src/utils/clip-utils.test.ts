// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { htmlForReaderClip } from './clip-utils';

function readerArticle(original: string, live: string): HTMLElement {
	const article = document.createElement('article');
	article.className = 'obsidian-reader-content';
	article.setAttribute('data-original-html', original);
	article.innerHTML = live;
	return article;
}

describe('htmlForReaderClip', () => {
	test('returns the original snapshot when nothing has been translated', () => {
		const article = readerArticle(
			'<p>Hello <strong>world</strong>.</p>',
			'<p data-reader-translate-source="pending">Hello <strong>world</strong>.</p>'
		);
		expect(htmlForReaderClip(article)).toBe('<p>Hello <strong>world</strong>.</p>');
	});

	test('inserts a finished translation as a normal paragraph, not a quote', () => {
		const article = readerArticle(
			'<p>Hello <strong>world</strong>.</p>',
			[
				'<p data-reader-translate-source="done">Hello <strong>world</strong>.</p>',
				'<div class="reader-translation" data-reader-translation="true">你好<strong>世界</strong>。</div>'
			].join('')
		);

		const html = htmlForReaderClip(article);
		expect(html).toContain('<p>Hello <strong>world</strong>.</p>');
		expect(html).toContain('<p>你好<strong>世界</strong>。</p>');
		expect(html).not.toContain('blockquote');
		expect(html).not.toContain('callout');
		expect(html).not.toContain('reader-translation');
	});

	test('skips loading placeholders', () => {
		const article = readerArticle(
			'<p>Hello</p>',
			'<p data-reader-translate-source="pending">Hello</p><div class="reader-translation is-loading"></div>'
		);
		expect(htmlForReaderClip(article)).toBe('<p>Hello</p>');
	});
});
