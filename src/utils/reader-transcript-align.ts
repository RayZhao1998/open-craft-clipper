// Lining a translated caption line back up with the line it came from.
//
// A caption is translated as one whole line, so the translation arrives with no
// timestamps of its own. Everything the player does with the original — underline
// the words being spoken, jump to the moment when you click one — has to be
// inferred for the translation instead.
//
// The inference is anchored on sentence ends: the i-th sentence of the original
// and the i-th sentence of the translation describe the same stretch of time, so
// offsets between two consecutive anchors are interpolated. That is exact at the
// boundaries and close everywhere else, and it survives a model that reorders a
// clause inside a sentence.
//
// When a model merges or splits sentences the counts stop matching, so boundaries
// are paired by how far through the line they sit, kept strictly increasing so the
// map never doubles back on itself.

export interface TextSpan {
	start: number;
	end: number;
}

// CJK-aware text boundary helpers, shared with the player: both the karaoke scan
// and the alignment need one definition of "a sentence ends here".
export const SENT_END = /[.!?。！？]/;
export const SOFT_STOP = /[,、，]/;
const CJK_SENT_END = /[。！？]/;
const CJK_PUNCT = /[。！？、，]/;
const CJK_CHAR = /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

// CJK punctuation doesn't require trailing whitespace
export function isSentBoundary(text: string, punctPos: number, nextPos: number): boolean {
	const ch = text[punctPos];
	if (CJK_SENT_END.test(ch)) return true;
	if (/[.!?]/.test(ch)) return nextPos >= text.length || /\s/.test(text[nextPos]);
	return false;
}

export function isSentOrSoftBoundary(text: string, punctPos: number, nextPos: number): boolean {
	const ch = text[punctPos];
	if (CJK_PUNCT.test(ch)) return true;
	if (/[.!?,]/.test(ch)) return nextPos >= text.length || /\s/.test(text[nextPos]);
	return false;
}

// In CJK text each character acts as its own word
export function isWordStep(text: string, pos: number): boolean {
	if (CJK_CHAR.test(text[pos])) return true;
	if (pos > 0 && CJK_CHAR.test(text[pos - 1]) && !CJK_CHAR.test(text[pos]) && /\S/.test(text[pos])) return true;
	return false;
}

/** Where each sentence ends, as exclusive offsets, leaving out the end of the line itself. */
function sentenceEndOffsets(text: string): number[] {
	const ends: number[] = [];
	for (let pos = 1; pos <= text.length; pos++) {
		if (isSentBoundary(text, pos - 1, pos)) {
			// The end of the line is an anchor on its own, in both directions.
			if (pos >= text.length) break;
			ends.push(pos);
		}
	}
	return ends;
}

/** Points to interpolate between, sorted and strictly increasing on both axes. */
type Anchors = Array<[source: number, translation: number]>;

function pairBoundaries(source: string, translation: string): Anchors {
	const srcEnds = sentenceEndOffsets(source);
	const trEnds = sentenceEndOffsets(translation);
	const anchors: Anchors = [[0, 0]];

	const push = (sourceOffset: number, translationOffset: number) => {
		const last = anchors[anchors.length - 1];
		if (sourceOffset <= last[0] || translationOffset <= last[1]) return;
		anchors.push([sourceOffset, translationOffset]);
	};

	if (srcEnds.length && srcEnds.length === trEnds.length) {
		// Same number of sentences: they line up one to one, which is far more
		// trustworthy than where the characters happen to fall.
		for (let i = 0; i < srcEnds.length; i++) push(srcEnds[i], trEnds[i]);
	} else {
		// Otherwise pair by how far through the line each boundary sits, walking the
		// original in order so the result stays monotonic.
		let bestSoFar = 0;
		for (const end of srcEnds) {
			const ratio = end / source.length;
			let best = -1;
			let bestGap = Infinity;
			for (const trEnd of trEnds) {
				if (trEnd <= bestSoFar) continue;
				const gap = Math.abs(trEnd / translation.length - ratio);
				if (gap < bestGap) { bestGap = gap; best = trEnd; }
			}
			if (best < 0) continue;
			push(end, best);
			bestSoFar = best;
		}
	}

	push(source.length, translation.length);
	return anchors;
}

/** Linear interpolation along a monotone list of [x, y] points, clamped at both ends. */
function interpolate(points: Anchors, x: number): number {
	if (x <= points[0][0]) return points[0][1];
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i];
		if (x <= x1) return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
	}
	return points[points.length - 1][1];
}

export interface OffsetMap {
	/** Position in the translation for a position in the original. */
	toTranslation(sourceOffset: number): number;
	/** Position in the original for a position in the translation. */
	toSource(translationOffset: number): number;
}

/**
 * Map offsets between a caption line and its translation. The two ends always
 * correspond, so the map is defined for a translation of any shape — including
 * an empty or single-word one.
 */
export function alignCaption(source: string, translation: string): OffsetMap {
	const forward: Anchors = source.length && translation.length
		? pairBoundaries(source, translation)
		: [[0, 0]];
	const backward: Anchors = forward.map(([s, t]) => [t, s]);

	return {
		toTranslation(sourceOffset: number): number {
			return Math.round(interpolate(forward, Math.min(source.length, Math.max(0, sourceOffset))));
		},
		toSource(translationOffset: number): number {
			return Math.round(interpolate(backward, Math.min(translation.length, Math.max(0, translationOffset))));
		}
	};
}

/**
 * The stretch of the translation that corresponds to a stretch of the original.
 * Ends land where the interpolation puts them, which is a sentence boundary
 * whenever the source span starts or ends at one. The way back is the same map
 * run in reverse: `alignCaption(source, translation).toSource`.
 */
export function mapSpanToTranslation(source: string, translation: string, span: TextSpan): TextSpan {
	const map = alignCaption(source, translation);
	const start = map.toTranslation(span.start);
	const end = map.toTranslation(span.end);
	return end > start ? { start, end } : { start: 0, end: 0 };
}
