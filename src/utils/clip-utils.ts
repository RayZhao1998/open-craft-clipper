import Defuddle from 'defuddle/full';
import { serializeChildren, setElementHTML } from './dom-utils';

/**
 * HTML of a Reader article that is safe to run through Defuddle.
 *
 * Starts from the snapshot taken when Reader opened (no chrome, no
 * placeholders) and splices in finished translations as ordinary
 * paragraphs / list items — never as a blockquote or callout.
 */
export function htmlForReaderClip(article: HTMLElement): string {
	const originalHtml = article.getAttribute('data-original-html');
	const pairs = collectFinishedTranslations(article);
	if (!originalHtml) {
		return serializeLiveForClip(article);
	}
	if (!pairs.length) return originalHtml;

	const tmp = article.ownerDocument.implementation.createHTMLDocument();
	setElementHTML(tmp.body, originalHtml);

	const originals = Array.from(tmp.body.querySelectorAll<HTMLElement>(CLIP_BLOCK_SELECTOR));
	let index = 0;

	for (const pair of pairs) {
		while (index < originals.length) {
			const candidate = originals[index++];
			const candidateText = normalizeClipText(candidate.textContent);
			if (!candidateText) continue;
			if (candidateText === pair.sourceText || candidateText.includes(pair.sourceText) || pair.sourceText.includes(candidateText)) {
				insertTranslationAfter(candidate, pair);
				break;
			}
		}
	}

	return serializeChildren(tmp.body);
}

const CLIP_BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, caption, blockquote, dd, dt, th, td, address, .transcript-segment-text';

interface TranslationPair {
	sourceText: string;
	innerHTML: string;
	listItem: boolean;
	contained: boolean;
}

function collectFinishedTranslations(article: HTMLElement): TranslationPair[] {
	const pairs: TranslationPair[] = [];
	article.querySelectorAll<HTMLElement>('[data-reader-translate-source="done"]').forEach(source => {
		const contained = source.matches('th, td, dt, dd');
		const trans = contained
			? source.querySelector<HTMLElement>(':scope > .reader-translation:not(.is-loading)')
			: nextFinishedTranslation(source);
		if (!trans) return;
		pairs.push({
			sourceText: sourcePlainText(source),
			innerHTML: trans.innerHTML,
			listItem: source.tagName === 'LI' || trans.tagName === 'LI',
			contained
		});
	});
	return pairs;
}

function nextFinishedTranslation(source: HTMLElement): HTMLElement | null {
	const next = source.nextElementSibling as HTMLElement | null;
	if (!next?.classList.contains('reader-translation')) return null;
	if (next.classList.contains('is-loading')) return null;
	return next;
}

function sourcePlainText(el: HTMLElement): string {
	const clone = el.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('.reader-translation, .timestamp, .footnote-anchor, .footnote-popover').forEach(node => node.remove());
	return normalizeClipText(clone.textContent);
}

function normalizeClipText(value: string | null | undefined): string {
	return (value || '').replace(/\s+/g, ' ').trim();
}

function insertTranslationAfter(source: HTMLElement, pair: TranslationPair): void {
	const doc = source.ownerDocument;
	const tag = pair.listItem ? 'li' : 'p';
	const node = doc.createElement(tag);
	setElementHTML(node, pair.innerHTML);
	if (pair.contained) {
		source.appendChild(node);
	} else {
		source.insertAdjacentElement('afterend', node);
	}
}

function serializeLiveForClip(article: HTMLElement): string {
	const live = article.cloneNode(true) as HTMLElement;
	live.querySelectorAll('.reader-translation.is-loading, .reader-translate-toast').forEach(node => node.remove());
	live.querySelectorAll('.reader-translation').forEach(node => {
		const el = node as HTMLElement;
		const replacement = live.ownerDocument.createElement(el.tagName === 'LI' ? 'li' : 'p');
		replacement.replaceChildren(...Array.from(el.childNodes).map(child => child.cloneNode(true)));
		el.replaceWith(replacement);
	});
	live.querySelectorAll('[data-reader-translate-source]').forEach(el => {
		el.removeAttribute('data-reader-translate-source');
	});
	return serializeChildren(live);
}

// Parse document content for clipping. In reader mode, start from the article
// snapshot and fold finished translations in as normal blocks.
export function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article') as HTMLElement | null;
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		setElementHTML(readerDoc.body, htmlForReaderClip(readerArticle));
		return new Defuddle(readerDoc, { url: doc.URL || '' }).parse();
	}
	return new Defuddle(doc, { url: doc.URL }).parse();
}
