// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { extractBlockText } from './reader-translate';

function firstBlock(markup: string): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.innerHTML = markup;
	return wrapper.firstElementChild as HTMLElement;
}

describe('extractBlockText', () => {
	test('keeps the spaces around inline markup', () => {
		const el = firstBlock('<p>The <strong>quick</strong> <a href="#">brown fox</a> jumped.</p>');
		expect(extractBlockText(el)).toBe('The quick brown fox jumped.');
	});

	test('drops inline code instead of sending it to the model', () => {
		const el = firstBlock('<p>Say <code>npm ci</code> now</p>');
		expect(extractBlockText(el)).toBe('Say now');
	});

	test('normalises whitespace but keeps <br> as a line break', () => {
		const el = firstBlock('<p>Line one<br>  Line two   <br/>Line three</p>');
		expect(extractBlockText(el)).toBe('Line one\nLine two\nLine three');
	});

	test('skips the transcript timestamp but keeps the spoken line', () => {
		// wireTranscript builds this with DOM APIs, so the text div really is a
		// child of the <p> — parsing that markup from a string would not nest it.
		const paragraph = document.createElement('p');
		paragraph.className = 'transcript-segment';

		const strong = document.createElement('strong');
		const timestamp = document.createElement('span');
		timestamp.className = 'timestamp';
		timestamp.textContent = '0:12';
		strong.appendChild(timestamp);
		paragraph.appendChild(strong);

		const text = document.createElement('div');
		text.className = 'transcript-segment-text';
		text.textContent = 'Welcome back to the show.';
		paragraph.appendChild(text);

		expect(extractBlockText(paragraph)).toBe('Welcome back to the show.');
	});

	test('ignores text inside an existing translation node', () => {
		const el = firstBlock('<p>Source text<span class="reader-translation">已有译文</span></p>');
		expect(extractBlockText(el)).toBe('Source text');
	});

	test('ignores footnote anchors and buttons', () => {
		const el = firstBlock('<p>Real sentence<sup class="footnote-anchor">1</sup><button>Copy</button></p>');
		expect(extractBlockText(el)).toBe('Real sentence');
	});

	test('returns an empty string for a block with nothing but chrome', () => {
		const el = firstBlock('<p><code>npm install</code><span>   </span></p>');
		expect(extractBlockText(el)).toBe('');
	});
});
