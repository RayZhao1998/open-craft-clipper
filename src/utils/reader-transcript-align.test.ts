import { describe, test, expect } from 'vitest';
import { alignCaption, mapSpanToTranslation } from './reader-transcript-align';

// A real caption line from a distributed-systems lecture, and the translation a
// model gives for it. Sentence counts match here: two internal boundaries on each
// side (the final one is the end of the line, which is an anchor by itself).
const SOURCE = 'Um So, the reasons why people build this stuff the First of all, before I even '
	+ 'talk about distributed systems, just want to remind you that, you know, if you are designing '
	+ 'a system or you are designing, you need to solve some problem. If you can possibly solve it on '
	+ 'a single computer, you know, without building a distributed system, you should do it that way.';
const TRANSLATION = '嗯，人们构建这些东西的原因。首先，在我甚至开始讨论分布式系统之前，只想提醒你，'
	+ '你知道，如果你正在设计一个系统，或者你需要解决某个问题。'
	+ '如果可以在单台计算机上解决它，而不构建分布式系统，你就应该这样做。';

describe('alignCaption', () => {
	const map = alignCaption(SOURCE, TRANSLATION);

	test('the ends of the line correspond exactly', () => {
		expect(map.toTranslation(0)).toBe(0);
		expect(map.toTranslation(SOURCE.length)).toBe(TRANSLATION.length);
		expect(map.toSource(0)).toBe(0);
		expect(map.toSource(TRANSLATION.length)).toBe(SOURCE.length);
	});

	test('never walks backwards as the video moves forwards', () => {
		let previous = -1;
		for (let offset = 0; offset <= SOURCE.length; offset++) {
			const mapped = map.toTranslation(offset);
			expect(mapped).toBeGreaterThanOrEqual(previous);
			previous = mapped;
		}
	});

	test('lands in the matching sentence, not just the matching fraction', () => {
		// Midway through the second spoken sentence of the original.
		const startOfSecond = SOURCE.indexOf('If you can possibly');
		const middle = startOfSecond + 20;
		const mapped = map.toTranslation(middle);
		const startOfChineseSecond = TRANSLATION.indexOf('如果可以');

		expect(mapped).toBeGreaterThanOrEqual(startOfChineseSecond);
		expect(mapped).toBeLessThan(TRANSLATION.length);
	});

	test('round-trips a click in the translation back to the spoken word', () => {
		for (let offset = 0; offset <= SOURCE.length; offset += 7) {
			const there = map.toTranslation(offset);
			expect(Math.abs(map.toSource(there) - offset)).toBeLessThanOrEqual(2);
		}
	});

	test('pairs sentences one to one when both sides cut the line the same number of times', () => {
		// The first Chinese sentence is much shorter than the English it translates.
		// A fraction-only map would drift off its end; counting sentences pins it.
		const english = 'Short one. This is a much longer second sentence with a lot of words in it. Third.';
		const chinese = '第一句很短。第二句长。第三句。';
		const pair = alignCaption(english, chinese);
		expect(pair.toTranslation(10)).toBe(chinese.indexOf('第一句很短。') + '第一句很短。'.length);
	});

	test('pairs by how far through the line a cut sits when the counts differ', () => {
		// The caption has one full stop; the translation cut it into three. The one
		// real boundary still has to land on a sentence end of the translation, not
		// on the fraction of characters it happens to sit at.
		const boundary = SOURCE.indexOf('problem.') + 'problem.'.length;
		const mapped = map.toTranslation(boundary);
		const chineseEnds = ['原因。', '问题。'].map(part => TRANSLATION.indexOf(part) + part.length);

		expect(chineseEnds).toContain(mapped);
	});

	test('keeps working when the model merges two sentences into one', () => {
		const merged = '这是一句很长的中文译文，把两句合成了一句说的。';
		const mergedMap = alignCaption('First sentence here. Second sentence here.', merged);
		let previous = -1;
		for (let offset = 0; offset <= 47; offset++) {
			expect(mergedMap.toTranslation(offset)).toBeGreaterThanOrEqual(previous);
			previous = mergedMap.toTranslation(offset);
		}
		expect(mergedMap.toTranslation(0)).toBe(0);
		expect(mergedMap.toTranslation(47)).toBe(merged.length);
	});

	test('survives a translation that has not arrived or came back empty', () => {
		const empty = alignCaption(SOURCE, '');
		expect(empty.toTranslation(10)).toBe(0);
		expect(empty.toSource(10)).toBe(0);

		// Offsets outside the line clamp instead of throwing.
		expect(map.toTranslation(SOURCE.length + 500)).toBe(TRANSLATION.length);
		expect(map.toSource(-5)).toBe(0);
	});

	test('anchors CJK source text, which has no spaces around its full stops', () => {
		const cjk = '第一句话在这里。第二句话在这里。第三句话结束。';
		const latin = 'First sentence here. Second sentence here. Third one ends.';
		const cjkMap = alignCaption(cjk, latin);
		// The anchor is the end of the second sentence, which is the character right
		// before the space that starts the third.
		expect(cjkMap.toTranslation(cjk.indexOf('第三句话'))).toBe(latin.indexOf('Third') - 1);
	});

	test('never maps inside a translation shorter than the original', () => {
		const tiny = alignCaption(SOURCE, '对。');
		let previous = -1;
		for (let offset = 0; offset <= SOURCE.length; offset++) {
			const mapped = tiny.toTranslation(offset);
			expect(mapped).toBeGreaterThanOrEqual(previous);
			expect(mapped).toBeLessThanOrEqual(2);
			previous = mapped;
		}
	});
});

describe('mapSpanToTranslation', () => {
	test('maps a sentence onto the sentence that stands for it', () => {
		const start = SOURCE.indexOf('If you can possibly');
		const span = mapSpanToTranslation(SOURCE, TRANSLATION, { start, end: SOURCE.length });
		const chineseStart = TRANSLATION.indexOf('如果可以');

		expect(span.start).toBe(chineseStart);
		expect(span.end).toBe(TRANSLATION.length);
	});

	test('returns an empty span when the source span is empty', () => {
		expect(mapSpanToTranslation(SOURCE, TRANSLATION, { start: 40, end: 40 })).toEqual({ start: 0, end: 0 });
	});
});

describe('a clicked phrase in the translation', () => {
	test('points back at the words being spoken', () => {
		const map = alignCaption(SOURCE, TRANSLATION);
		const phrase = '而不构建分布式系统';
		const start = TRANSLATION.indexOf(phrase);
		const spoken = SOURCE.slice(map.toSource(start), map.toSource(start + phrase.length));

		expect(spoken).toContain('without building a distributed');
	});
});
