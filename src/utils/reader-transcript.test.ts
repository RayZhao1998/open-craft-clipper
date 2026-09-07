// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { createMirror, speechSpan } from './reader-transcript';
import { mapSpanToTranslation } from './reader-transcript-align';

function block(text: string, className = 'transcript-segment-text'): HTMLElement {
	const el = document.createElement('div');
	el.className = className;
	el.textContent = text;
	return el;
}

describe('createMirror', () => {
	test('reads a translation broken by hard breaks as one string', () => {
		const el = document.createElement('div');
		el.className = 'reader-translation reader-translation-segment';
		el.appendChild(document.createTextNode('第一句。'));
		el.appendChild(document.createElement('br'));
		el.appendChild(document.createTextNode('第二句。'));

		const mirror = createMirror(el)!;
		expect(mirror.text).toBe('第一句。第二句。');

		// A caret in the second line is still an offset into the whole caption.
		const secondLine = el.childNodes[2];
		expect(mirror.flatOffset(secondLine, 1)).toBe('第一句。'.length + 1);
	});

	test('has no mirror for a placeholder whose translation has not arrived', () => {
		const placeholder = document.createElement('div');
		placeholder.className = 'reader-translation reader-translation-segment is-loading';
		expect(createMirror(placeholder)).toBeNull();
		expect(createMirror(null)).toBeNull();
	});

	test('cuts a range out across a line break', () => {
		const mirror = createMirror(block('First line here.\nSecond line here.'))!;
		const range = mirror.range(6, 24)!;
		expect(range.toString()).toBe('line here.\nSecond ');
	});

	test('reports a caret outside the text as -1', () => {
		const mirror = createMirror(block('Spoken line'))!;
		expect(mirror.flatOffset(document.createTextNode('other'), 0)).toBe(-1);
	});
});

describe('speechSpan', () => {
	// jsdom lays nothing out, so these run down the unmeasured path: the span is
	// bounded by punctuation and a character budget instead of by lines. That is
	// also the path a hidden original takes in "translation only" mode.
	const text = 'First sentence here. Then some more words follow after that one.';
	const mirror = createMirror(block(text))!;

	test('starts the span at the sentence being spoken', () => {
		const span = speechSpan(mirror, 30, false)!;
		expect(text.slice(span.start, span.end)).toBe('Then some more words follow after that one.');
	});

	test('starts at the head of the line while the first words are still spoken', () => {
		const span = speechSpan(mirror, 4, true)!;
		expect(span.start).toBe(0);
		expect(text.slice(span.start, span.end)).toBe('First sentence here.');
	});

	test('never runs away past a sentence-less caption', () => {
		const runOn = createMirror(block('and '.repeat(60)))!;
		const span = speechSpan(runOn, 120, false)!;
		// 40 characters back and 60 forward: a karaoke bar, not the whole line.
		expect(span.end - span.start).toBeLessThanOrEqual(102);
	});
});

describe('a spoken span carried into the translation', () => {
	test('lights up the sentence that stands for the one being spoken', () => {
		const source = 'You need to solve some problem. If you can solve it on a single computer, you should do it that way.';
		const translation = '你需要解决某个问题。如果可以在单台计算机上解决它，你就应该这样做。';
		const spoken = createMirror(block(source))!;
		const translated = createMirror(block(translation, 'reader-translation reader-translation-segment'))!;

		// A quarter of the way into the second sentence of the original.
		const charPos = source.indexOf('single computer') + 6;
		const span = speechSpan(spoken, charPos, false)!;
		const mirrored = mapSpanToTranslation(source, translation, span);

		expect(translation.slice(mirrored.start, mirrored.end)).toContain('单台计算机');
		expect(mirrored.start).toBeGreaterThanOrEqual(translation.indexOf('如果'));
	});
});
