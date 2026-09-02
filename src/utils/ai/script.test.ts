import { describe, test, expect } from 'vitest';
import { dominantScript, hasTranslatableContent, scriptForLanguage, shouldSkipTranslation } from './script';

describe('dominantScript', () => {
	test('detects the common scripts', () => {
		expect(dominantScript('Hello world')).toBe('latin');
		expect(dominantScript('这是一个中文句子')).toBe('han');
		expect(dominantScript('これは日本語の文です')).toBe('kana');
		expect(dominantScript('한국어 문장입니다')).toBe('hangul');
		expect(dominantScript('Привет мир')).toBe('cyrillic');
		expect(dominantScript('مرحبا بالعالم')).toBe('arabic');
	});

	test('returns none for text with no letters', () => {
		expect(dominantScript('1,234.56 · 🙂')).toBe('none');
		expect(dominantScript('')).toBe('none');
	});

	test('Japanese stays Japanese even when kanji dominates', () => {
		expect(dominantScript('東京大学図書館で日本語を勉強しています')).toBe('kana');
	});

	test('a Chinese sentence with one loanword is still Chinese', () => {
		expect(dominantScript('我们在 API 的设计上做了取舍')).toBe('han');
	});
});

describe('scriptForLanguage', () => {
	test('maps language codes to scripts', () => {
		expect(scriptForLanguage('zh-CN')).toBe('han');
		expect(scriptForLanguage('zh_TW')).toBe('han');
		expect(scriptForLanguage('ja')).toBe('kana');
		expect(scriptForLanguage('en')).toBe('latin');
		expect(scriptForLanguage('')).toBeUndefined();
		expect(scriptForLanguage('xx')).toBeUndefined();
	});
});

describe('hasTranslatableContent', () => {
	test('rejects code-ish and number-ish fragments', () => {
		expect(hasTranslatableContent('https://example.com/a/b?c=1')).toBe(false);
		expect(hasTranslatableContent('2024-01-02')).toBe(false);
		expect(hasTranslatableContent('42')).toBe(false);
		expect(hasTranslatableContent('🙂')).toBe(false);
		expect(hasTranslatableContent('v1.2.3')).toBe(false);
	});

	test('accepts short real words', () => {
		expect(hasTranslatableContent('Hello')).toBe(true);
		expect(hasTranslatableContent('你好')).toBe(true);
	});
});

describe('shouldSkipTranslation', () => {
	test('translates a foreign-language block', () => {
		expect(shouldSkipTranslation('This is an English paragraph.', 'zh-CN').skip).toBe(false);
	});

	test('skips text already in the target language', () => {
		expect(shouldSkipTranslation('这是一段中文。', 'zh-CN')).toEqual({ skip: true, reason: 'target' });
		expect(shouldSkipTranslation('Hello there, friend.', 'en')).toEqual({ skip: true, reason: 'target' });
	});

	test('still translates Chinese into Japanese even though both use han', () => {
		// Japanese is keyed on kana, so a han-only source is not "already Japanese".
		expect(shouldSkipTranslation('这是一段中文。', 'ja').skip).toBe(false);
	});

	test('skips empties and noise', () => {
		expect(shouldSkipTranslation('   ', 'zh-CN').skip).toBe(true);
		expect(shouldSkipTranslation('0.0', 'zh-CN').skip).toBe(true);
	});

	test('leaves the decision to the model for unknown target codes', () => {
		expect(shouldSkipTranslation('これは日本語です', 'xx').skip).toBe(false);
	});
});
