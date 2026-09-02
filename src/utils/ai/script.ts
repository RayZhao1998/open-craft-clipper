// Script sniffing used to decide what is worth paying tokens for.
//
// We are not guessing the language of the page — we only answer "does this block
// already read like the target language / does it contain any translatable
// words at all?". Both answers let us skip a segment without a request, which is
// what keeps an immersive translation of a long article affordable.

export type ScriptName = 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'hebrew' | 'devanagari' | 'thai' | 'latin' | 'other';

const RANGES: Array<{ name: ScriptName; test: (code: number) => boolean }> = [
	{ name: 'kana', test: c => (c >= 0x3040 && c <= 0x30ff) || c === 0x30fc },
	{ name: 'hangul', test: c => (c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) },
	{ name: 'han', test: c => (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2ebef) },
	{ name: 'cyrillic', test: c => c >= 0x0400 && c <= 0x04ff },
	{ name: 'arabic', test: c => (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) },
	{ name: 'hebrew', test: c => c >= 0x0590 && c <= 0x05ff },
	{ name: 'devanagari', test: c => c >= 0x0900 && c <= 0x097f },
	{ name: 'thai', test: c => c >= 0x0e00 && c <= 0x0e7f },
	{ name: 'latin', test: c => (c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a) || (c >= 0x00c0 && c <= 0x024f) }
];

const LANGUAGE_SCRIPT: Record<string, ScriptName> = {
	'zh': 'han', 'yue': 'han',
	'ja': 'kana',
	'ko': 'hangul',
	'ru': 'cyrillic', 'uk': 'cyrillic', 'bg': 'cyrillic', 'sr': 'cyrillic', 'mk': 'cyrillic',
	'ar': 'arabic', 'fa': 'arabic', 'ur': 'arabic',
	'he': 'hebrew',
	'hi': 'devanagari', 'mr': 'devanagari', 'ne': 'devanagari',
	'th': 'thai',
	'en': 'latin', 'de': 'latin', 'es': 'latin', 'fr': 'latin', 'it': 'latin', 'pt': 'latin',
	'nl': 'latin', 'sv': 'latin', 'da': 'latin', 'fi': 'latin', 'no': 'latin', 'pl': 'latin',
	'cs': 'latin', 'sk': 'latin', 'hu': 'latin', 'ro': 'latin', 'tr': 'latin', 'id': 'latin',
	'vi': 'latin', 'tl': 'latin', 'ms': 'latin', 'ca': 'latin', 'af': 'latin', 'el': 'other'
};

/** Dominant writing system of a string, ignoring whitespace and punctuation. */
export function dominantScript(text: string): ScriptName | 'none' {
	if (!text) return 'none';
	const counts = new Map<ScriptName, number>();
	let letters = 0;

	for (const char of text) {
		const code = char.codePointAt(0) || 0;
		for (const range of RANGES) {
			if (range.test(code)) {
				counts.set(range.name, (counts.get(range.name) || 0) + 1);
				letters++;
				break;
			}
		}
	}

	if (!letters) return 'none';

	const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
	let best = (ranked.length ? ranked[0][0] : 'other') as ScriptName;
	// Japanese mixes kana and kanji; kana wins when present in any real amount.
	if (best === 'han' && (counts.get('kana') || 0) > letters * 0.15) best = 'kana';
	return best;
}

export function scriptForLanguage(lang: string): ScriptName | undefined {
	// Accept "zh_TW" as well as "zh-TW": browser locales use underscores.
	const trimmed = (lang || '').trim().toLowerCase().replace(/_/g, '-');
	if (!trimmed) return undefined;
	return LANGUAGE_SCRIPT[trimmed] || LANGUAGE_SCRIPT[trimmed.split('-')[0]];
}

/** True when there is nothing here a model could usefully translate. */
export function hasTranslatableContent(text: string): boolean {
	const script = dominantScript(text);
	if (script === 'none') return false;

	// A URL, a number, a filename or an emoji-only line: nothing to translate.
	const lettersOnly = text.replace(/https?:\/\/\S+|\d+[.,:;/-]*\s*[a-zA-Z%]{0,4}|[\s\p{P}\p{S}]/gu, '');
	return lettersOnly.trim().length >= 2;
}

/**
 * Whether a block should be sent at all. `alreadyTarget` prevents translating a
 * Chinese article into Chinese (which is the common "why is it burning my quota"
 * report), and short fragments are not worth a request.
 */
export function shouldSkipTranslation(text: string, targetLang: string, minChars = 2): { skip: boolean; reason?: 'empty' | 'target' | 'short' } {
	const trimmed = (text || '').trim();
	if (!trimmed) return { skip: true, reason: 'empty' };
	if (!hasTranslatableContent(trimmed)) return { skip: true, reason: 'empty' };
	if (trimmed.length < minChars) return { skip: true, reason: 'short' };

	const target = scriptForLanguage(targetLang);
	if (target && target !== 'other') {
		const script = dominantScript(trimmed);
		// A Japanese page translated to Chinese still needs work (kana → han),
		// so only a matching script of the same kind counts as "already there".
		if (script === target) return { skip: true, reason: 'target' };
		// Chinese → Japanese (or the reverse) shares the han script but kana is absent,
		// so require the *source* to look like the target only for non-CJK pairs.
	}
	return { skip: false };
}
