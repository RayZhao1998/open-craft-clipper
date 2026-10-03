// Immersive translation inside Reader.
//
// How it stays cheap:
//   * Blocks are discovered once, then only the ones inside the viewport *plus
//     one viewport above and below* are queued (IntersectionObserver rootMargin),
//     so a 20k-word article costs the same per scroll as the screen you can see.
//   * Nothing is dispatched while the page is actually scrolling, so flying
//     through an article to look at it translates nothing.
//   * Segments are packed into ~1.4k-character requests, two in flight at a time,
//     nearest-to-the-reader first.
//   * Code, numbers, and text that is already in the target language never reach
//     the network, and results are cached per model+language so scrolling back
//     up is free.
//
// The source element is never rewritten: the translation is inserted as a
// sibling (or appended inside for list items and table cells), which keeps
// highlight anchors and the transcript player intact. Clipping copies those
// sibling translations as ordinary paragraphs so the note stays bilingual.

import browser from './browser-polyfill';
import { generalSettings, loadSettings } from './storage-utils';
import type { AiSettings } from '../types/types';
import { requestTranslations } from './ai/messenger';
import { isLocalEndpoint } from './ai/config';
import { shouldSkipTranslation } from './ai/script';
import {
	MAX_BATCH_CHARS,
	MAX_BATCH_SEGMENTS,
	MAX_CONCURRENT_REQUESTS,
	joinTranslationPieces,
	splitLongSegment,
	translationCache,
	translationCacheKey
} from './ai/translate';
import { getMessage } from './i18n';
import { debugLog } from './debug';

const VIEWPORT_MARGIN_RATIO = 1;   // one viewport above and below the screen
const SCROLL_IDLE_MS = 260;        // never spend tokens mid-scroll
const FLUSH_DELAY_MS = 140;
const MAX_ATTEMPTS = 2;
const MAX_CONSECUTIVE_FAILURES = 3;
const BATCH_CHARS = Math.min(MAX_BATCH_CHARS, 1400);
const BATCH_SEGMENTS = MAX_BATCH_SEGMENTS;

const BLOCK_SELECTOR = [
	'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'figcaption', 'caption', 'blockquote', 'dd', 'dt', 'th', 'td', 'address',
	// YouTube caption lines live in a span inside their segment.
	'.transcript-segment-text'
].join(', ');

// Translated inside the cell instead of after it: a stray sibling would break
// the row. These stay bilingual even in "translation only" mode (see the CSS).
const CONTAINED_SELECTOR = 'th, td, dt, dd';

// Text inside these is code, UI chrome or machine-generated — never prose.
const SKIP_INSIDE_SELECTOR = [
	'pre', 'code', 'kbd', 'samp', 'script', 'style', 'noscript',
	'button', 'select', 'option', 'textarea', 'input', 'svg', 'math',
	'.reader-translation', '.reader-translate-toast', '.timestamp', '.transcript-scrub-track',
	'.footnote-anchor', '.footnote-popover',
	'.obsidian-reader-settings', '.obsidian-reader-nav', '.obsidian-reader-footer',
	'.obsidian-reader-outline', '.obsidian-reader-left-sidebar', '.obsidian-reader-clip-dropdown',
	'.obsidian-selection-action', '.obsidian-highlighter-menu', '.obsidian-highlighter-overlays',
	'.player-toggles', '.player-container', '.comment-actions'
].join(', ');

const RTL_LANGS = ['ar', 'he', 'fa', 'ur', 'ps', 'ku', 'yi'];

type BlockState = 'new' | 'queued' | 'done' | 'skipped' | 'error';

interface TranslatableBlock {
	el: HTMLElement;
	text: string;
	/** text split into request-sized pieces (one piece in the normal case). */
	pieces: string[];
	transcript: boolean;
	state: BlockState;
	attempts: number;
	node?: HTMLElement;
}

const blocks = new WeakMap<HTMLElement, TranslatableBlock>();
// Discovered blocks are remembered so toggling translation off and on again can
// reset their state (the WeakMap itself is not iterable).
let discovered: TranslatableBlock[] = [];

let docRef: Document | null = null;
let observer: IntersectionObserver | null = null;
let contentObserver: MutationObserver | null = null;
let queuedBlocks = new Set<TranslatableBlock>();   // inside the translation runway
let inFlight = 0;
let flushTimer: number | null = null;
let lastScrollY = 0;
let lastScrollAt = 0;
let scrollListener: (() => void) | null = null;
let active = false;
let paused = false;
let failures = 0;
let settings: AiSettings | null = null;
let navButton: HTMLElement | null = null;
let toastTimer: number | null = null;

// --- Text extraction -----------------------------------------------------

function isTranscriptBlock(el: HTMLElement): boolean {
	// Only the spoken lines inside a caption row. Chapter headings live in the
	// same .transcript container but are ordinary blocks, and the caption styling
	// (indent under the timestamp) must not be applied to them.
	return Boolean(el.closest('.transcript-segment'));
}

/** Inner text with <br> preserved as newlines; chrome and code are left out. */
export function extractBlockText(el: HTMLElement): string {
	const doc = el.ownerDocument;
	const parts: string[] = [];
	const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode(node: Node): number {
			if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
			const parent = node.parentElement;
			if (!parent || parent.closest(SKIP_INSIDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
			// Whitespace-only nodes stay in: dropping them glues words together
			// whenever an inline element (a link, a <strong>) sits between them.
			return NodeFilter.FILTER_ACCEPT;
		}
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		parts.push((node.nodeValue || '').replace(/\s+/g, ' '));

		// Video descriptions use <br> instead of paragraphs; keep them as lines.
		const sibling = node.nextSibling;
		if (sibling && sibling.nodeName === 'BR') parts.push('\n');

		node = walker.nextNode();
	}

	return tidyExtracted(parts.join(''));
}

const MARKUP_CHROME_SELECTOR = [
	'pre', 'script', 'style', 'noscript',
	'button', 'select', 'option', 'textarea', 'input', 'svg', 'math',
	'.reader-translation', '.reader-translate-toast', '.timestamp', '.transcript-scrub-track',
	'.footnote-anchor', '.footnote-popover',
	'.obsidian-reader-settings', '.obsidian-reader-nav', '.obsidian-reader-footer',
	'.obsidian-reader-outline', '.obsidian-reader-left-sidebar', '.obsidian-reader-clip-dropdown',
	'.obsidian-selection-action', '.obsidian-highlighter-menu', '.obsidian-highlighter-overlays',
	'.player-toggles', '.player-container', '.comment-actions'
].join(', ');

function tidyExtracted(text: string): string {
	return text
		.replace(/[ \t]*\n[ \t]*/g, '\n')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();
}

/**
 * Same text as extractBlockText, with Markdown markers for the inline
 * formatting the model should keep (**bold**, *italic*, `code`, links).
 */
export function extractBlockMarkdown(el: HTMLElement): string {
	return tidyExtracted(markdownFromNode(el, el));
}

function markdownFromNode(node: Node, root: HTMLElement): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return (node.nodeValue || '').replace(/\s+/g, ' ');
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return '';

	const el = node as HTMLElement;
	if (el !== root && el.closest(MARKUP_CHROME_SELECTOR)) return '';
	if (el.tagName === 'BR') return '\n';

	const inner = Array.from(el.childNodes).map(child => markdownFromNode(child, root)).join('');

	switch (el.tagName) {
		case 'STRONG':
		case 'B':
			return inner.trim() ? `**${inner.trim()}**` : inner;
		case 'EM':
		case 'I':
			return inner.trim() ? `*${inner.trim()}*` : inner;
		case 'CODE':
		case 'KBD':
		case 'SAMP':
			return inner ? `\`${inner.replace(/`/g, '')}\`` : '';
		case 'MARK':
			return inner.trim() ? `==${inner.trim()}==` : inner;
		case 'A': {
			const href = (el.getAttribute('href') || '').trim();
			if (!inner.trim()) return inner;
			if (!href || /^(javascript:|data:)/i.test(href)) return inner;
			return `[${inner.trim()}](${href})`;
		}
		default:
			return inner;
	}
}

/** Turn a model string that may contain inline Markdown into DOM nodes. */
export function renderInlineMarkdown(doc: Document, text: string): DocumentFragment {
	const fragment = doc.createDocumentFragment();
	const lines = (text || '').split('\n');
	lines.forEach((line, index) => {
		if (index > 0) fragment.appendChild(doc.createElement('br'));
		appendInlineMarkdown(doc, fragment, line);
	});
	return fragment;
}

function appendInlineMarkdown(doc: Document, parent: Node, text: string): void {
	const token = /\*\*([^*]+)\*\*|\*([^*]+)\*|==([^=]+)==|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = token.exec(text))) {
		if (match.index > last) {
			parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
		}
		if (match[1] != null) {
			const strong = doc.createElement('strong');
			strong.textContent = match[1];
			parent.appendChild(strong);
		} else if (match[2] != null) {
			const em = doc.createElement('em');
			em.textContent = match[2];
			parent.appendChild(em);
		} else if (match[3] != null) {
			const mark = doc.createElement('mark');
			mark.textContent = match[3];
			parent.appendChild(mark);
		} else if (match[4] != null) {
			const code = doc.createElement('code');
			code.textContent = match[4];
			parent.appendChild(code);
		} else {
			const link = doc.createElement('a');
			link.setAttribute('href', match[6]);
			appendInlineMarkdown(doc, link, match[5]);
			parent.appendChild(link);
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

function fillTranslationNode(node: HTMLElement, text: string): void {
	node.replaceChildren();
	node.appendChild(renderInlineMarkdown(node.ownerDocument, text));
}

/** Deepest block-level elements only: a blockquote is translated per <p>. */
function isLeafBlock(el: HTMLElement): boolean {
	try {
		return !el.querySelector(BLOCK_SELECTOR);
	} catch {
		return false;
	}
}

/**
 * Blocks that become translation candidates, in document order. Exported for
 * tests: this is the contract for *what* Reader translates — article prose, the
 * YouTube description (a <p> with <br> lines) and the transcript
 * (`.transcript-segment-text` spans), but never code, chrome or timestamps.
 */
export function findTranslatableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(el => {
		if (el.closest(SKIP_INSIDE_SELECTOR)) return false;
		if (!isLeafBlock(el)) return false;
		return extractBlockText(el).replace(/\s/g, '').length > 1;
	});
}

function discoverBlocks(root: HTMLElement): TranslatableBlock[] {
	const found: TranslatableBlock[] = [];

	// findTranslatableElements() already dropped code, chrome and empty blocks.
	for (const el of findTranslatableElements(root)) {
		if (blocks.has(el)) continue;

		const plain = extractBlockText(el);
		const text = extractBlockMarkdown(el) || plain;
		const transcript = isTranscriptBlock(el);
		const block: TranslatableBlock = {
			el,
			text,
			pieces: splitLongSegment(text, BATCH_CHARS),
			transcript,
			state: 'new',
			attempts: 0
		};
		blocks.set(el, block);
		el.setAttribute('data-reader-translate-source', 'pending');

		// Captions are the most expensive part of a video, so they are opt-in.
		const skip = transcript && settings && !settings.translateTranscript
			? { skip: true as const }
			: shouldSkipTranslation(plain, settings?.targetLang || '', 2);
		if (skip.skip) {
			block.state = 'skipped';
			el.setAttribute('data-reader-translate-source', 'skipped');
		}
		found.push(block);
	}

	discovered = discovered.concat(found);
	return found;
}

// --- Batching ------------------------------------------------------------

interface Batch {
	blocks: TranslatableBlock[];
	texts: string[];
	/** Index range within `texts` that belongs to each block. */
	slices: Array<{ start: number; end: number }>;
}

function isRetryable(block: TranslatableBlock): boolean {
	return block.state === 'new' || (block.state === 'error' && block.attempts < MAX_ATTEMPTS);
}

function distanceFromViewportCenter(el: HTMLElement): number {
	const rect = el.getBoundingClientRect();
	return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
}

/**
 * Fill one request from the blocks inside the runway, nearest to the reader
 * first, stopping as soon as the next block would bust the char budget. Short
 * fragments (transcript lines, list items) still pack tightly.
 */
function buildBatch(): Batch | null {
	const candidates = Array.from(queuedBlocks)
		.filter(isRetryable)
		.map(block => ({ block, distance: distanceFromViewportCenter(block.el) }))
		.sort((a, b) => a.distance - b.distance);

	const picked: TranslatableBlock[] = [];
	const texts: string[] = [];
	const slices: Array<{ start: number; end: number }> = [];
	let chars = 0;

	for (const { block } of candidates) {
		if (picked.length >= BATCH_SEGMENTS) break;
		const size = block.text.length;
		if (picked.length && chars + size > BATCH_CHARS) break;

		const start = texts.length;
		for (const piece of block.pieces) texts.push(piece);
		slices.push({ start, end: texts.length });

		picked.push(block);
		chars += size;
		// An oversized block already fills the request with its own pieces.
		if (block.pieces.length > 1) break;
	}

	if (!picked.length) return null;
	picked.forEach(block => { block.state = 'queued'; block.attempts++; });

	return { blocks: picked, texts, slices };
}

// --- DOM -----------------------------------------------------------------

function createTranslationNode(text: string, targetLang: string, block: TranslatableBlock): HTMLElement {
	const doc = docRef!;
	// A list item gets its own <li> so the bullet list stays a list (and so it can
	// be hidden on its own in "translation only" mode).
	const tag = block.el.tagName === 'LI' ? 'li' : (block.el.tagName === 'SPAN' ? 'span' : 'div');
	const node = doc.createElement(tag);
	// `reader-translation-segment` is how the transcript player finds a caption's
	// translation: it lines the two up, so the playback highlight and click-to-seek
	// work in either language.
	node.className = 'reader-translation'
		+ (block.transcript ? ' reader-translation-segment' : '')
		+ (tag === 'li' ? ' reader-translation-item' : '');
	node.setAttribute('data-reader-translation', 'true');

	const base = (targetLang || '').split('-')[0].toLowerCase();
	if (targetLang) node.lang = targetLang;
	if (RTL_LANGS.includes(base)) {
		node.dir = 'rtl';
		node.classList.add('is-rtl');
	}

	if (text) fillTranslationNode(node, text);

	return node;
}

function insertTranslationNode(block: TranslatableBlock, node: HTMLElement): void {
	if (block.el.matches(CONTAINED_SELECTOR)) {
		// Inside the cell: a sibling of a cell would break the row.
		block.el.appendChild(node);
	} else {
		// Right after its source — including caption lines, whose translation
		// stays inside the segment row that the player measures.
		block.el.insertAdjacentElement('afterend', node);
	}
}

/**
 * A visible stand-in (spinner + label) while the translation of this block is
 * in flight. An empty placeholder just reads as unexplained blank space under
 * the sentence being translated.
 */
function markLoading(block: TranslatableBlock): void {
	if (!docRef || block.node) return;

	const node = createTranslationNode('', settings?.targetLang || '', block);
	node.classList.add('is-loading');
	node.setAttribute('aria-hidden', 'true');

	const spinner = docRef.createElement('span');
	spinner.className = 'reader-translation-spinner';
	node.appendChild(spinner);

	const label = docRef.createElement('span');
	label.className = 'reader-translation-label';
	label.textContent = getMessage('aiTranslatingLabel') || 'Translating…';
	node.appendChild(label);

	block.node = node;
	insertTranslationNode(block, node);
}

function discardPlaceholder(block: TranslatableBlock): void {
	block.node?.remove();
	block.node = undefined;
}

function attachTranslation(block: TranslatableBlock, text: string): void {
	if (!docRef) return;

	block.el.setAttribute('data-reader-translate-source', 'done');

	if (block.node) {
		// The placeholder is already in the right place; it becomes the answer.
		block.node.classList.remove('is-loading');
		block.node.removeAttribute('aria-hidden');
		fillTranslationNode(block.node, text);
		return;
	}

	const node = createTranslationNode(text, settings?.targetLang || '', block);
	block.node = node;
	insertTranslationNode(block, node);
}

function removeTranslations(doc: Document): void {
	doc.querySelectorAll('.reader-translation').forEach(node => node.remove());
	doc.querySelectorAll<HTMLElement>('[data-reader-translate-source]').forEach(el => {
		if (el.getAttribute('data-reader-translate-source') !== 'skipped') {
			el.setAttribute('data-reader-translate-source', 'pending');
		}
	});
	// Every node we were holding is detached now, placeholders included.
	for (const block of discovered) block.node = undefined;
}

function setBusy(busy: boolean): void {
	navButton?.classList.toggle('is-busy', busy);
}

// --- Dispatch ------------------------------------------------------------

function isScrolling(): boolean {
	return Date.now() - lastScrollAt < SCROLL_IDLE_MS;
}

function hasWork(): boolean {
	for (const block of queuedBlocks) {
		if (isRetryable(block)) return true;
	}
	return false;
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
	if (!active || paused || flushTimer !== null) return;

	flushTimer = window.setTimeout(() => {
		flushTimer = null;
		if (isScrolling()) {
			// Check again once the page settles instead of churning timers.
			scheduleFlush(SCROLL_IDLE_MS);
			return;
		}
		pump();
	}, delay);
}

/** Start as many batches as the concurrency budget allows. */
function pump(): void {
	if (!active || paused || !settings) return;

	while (inFlight < MAX_CONCURRENT_REQUESTS) {
		const batch = buildBatch();
		if (!batch) break;

		const remoteBlocks: TranslatableBlock[] = [];
		const remoteSlices: Array<{ start: number; end: number }> = [];
		const texts: string[] = [];

		batch.blocks.forEach((block, index) => {
			const key = translationCacheKey({
				baseUrl: settings!.baseUrl,
				model: settings!.model,
				targetLang: settings!.targetLang,
				prompt: settings!.prompt
			}, block.text);
			const hit = translationCache.get(key);
			if (hit !== undefined) {
				block.state = 'done';
				attachTranslation(block, hit);
				return;
			}
			const slice = batch.slices[index];
			const start = texts.length;
			for (let offset = slice.start; offset < slice.end; offset++) texts.push(batch.texts[offset]);
			remoteBlocks.push(block);
			remoteSlices.push({ start, end: texts.length });
		});

		if (!remoteBlocks.length) continue;

		inFlight++;
		setBusy(true);
		void runBatch({ blocks: remoteBlocks, slices: remoteSlices, texts }).finally(() => {
			inFlight--;
			setBusy(inFlight > 0);
			// A slot just freed; keep the pipeline full.
			scheduleFlush(0);
		});
	}
}

async function runBatch(batch: Batch): Promise<void> {
	const blocks = batch.blocks;
	const release = () => blocks.forEach(block => {
		if (block.state === 'queued') block.state = 'new';
		discardPlaceholder(block);
	});
	if (!settings || !docRef || !active) {
		release();
		return;
	}

	const { baseUrl, targetLang, prompt } = settings;
	// Show where the request is working, not just that something is happening.
	blocks.forEach(markLoading);

	try {
		const translations = await requestTranslations(batch.texts, { targetLang, prompt });
		failures = 0;

		// The reader may have been turned off, or the article replaced, while we
		// were waiting — do not write into a page that stopped translating.
		if (!active) {
			release();
			return;
		}

		blocks.forEach((block, index) => {
			const slice = batch.slices[index];
			const pieces: (string | null)[] = [];
			for (let offset = slice.start; offset < slice.end; offset++) pieces.push(translations[offset] ?? null);
			const value = joinTranslationPieces(pieces);

			if (value) {
				block.state = 'done';
				attachTranslation(block, value);
				translationCache.set(
					translationCacheKey({ baseUrl, model: settings!.model, targetLang, prompt }, block.text),
					value
				);
			} else if (block.attempts >= MAX_ATTEMPTS) {
				block.state = 'skipped';
				discardPlaceholder(block);
				block.el.setAttribute('data-reader-translate-source', 'skipped');
			} else {
				block.state = 'new';
				discardPlaceholder(block);
			}
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		debugLog('Translate', 'Translation request failed:', message);
		failures++;

		blocks.forEach(block => {
			block.state = block.attempts >= MAX_ATTEMPTS ? 'error' : 'new';
			discardPlaceholder(block);
		});

		// Stop rather than keep hammering a broken (or unbilled) endpoint.
		if (failures >= MAX_CONSECUTIVE_FAILURES) {
			paused = true;
			setBusy(false);
			showToast(message, true);
		}
	}
}

// --- Toast ---------------------------------------------------------------

function showToast(message: string, isError = false): void {
	const doc = docRef;
	if (!doc || !doc.body) return;

	let toast = doc.querySelector('.reader-translate-toast') as HTMLElement | null;
	if (!toast) {
		toast = doc.createElement('div');
		toast.className = 'reader-translate-toast';
		doc.body.appendChild(toast);
	}

	toast.classList.toggle('is-error', isError);
	toast.classList.remove('is-hidden');
	toast.textContent = '';

	const label = doc.createElement('span');
	label.textContent = message;
	toast.appendChild(label);

	const link = doc.createElement('a');
	link.href = browser.runtime.getURL('settings.html?section=ai');
	link.target = '_blank';
	link.rel = 'noopener';
	link.textContent = getMessage('aiOpenSettings') || 'AI settings';
	toast.appendChild(link);

	if (toastTimer !== null) window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => toast?.classList.add('is-hidden'), isError ? 12000 : 5000);
}

// --- Observers -----------------------------------------------------------

function createObserver(): IntersectionObserver | null {
	if (typeof IntersectionObserver === 'undefined') return null;
	const margin = Math.round(window.innerHeight * VIEWPORT_MARGIN_RATIO);

	// One viewport of runway above and below — the whole token-budget story.
	return new IntersectionObserver((entries) => {
		if (!active) return;
		for (const entry of entries) {
			const block = blocks.get(entry.target as HTMLElement);
			if (!block || block.state === 'done' || block.state === 'skipped') continue;
			if (entry.isIntersecting) queuedBlocks.add(block);
			else if (isRetryable(block)) queuedBlocks.delete(block);
		}
		scheduleFlush();
	}, { rootMargin: `${margin}px 0px ${margin}px 0px`, threshold: 0 });
}

function observeBlocks(list: TranslatableBlock[]): void {
	if (!observer) return;
	for (const block of list) {
		if (block.state === 'new' || block.state === 'error') observer.observe(block.el);
	}
}

function installScrollWatch(): void {
	if (scrollListener) return;
	lastScrollY = window.scrollY;
	lastScrollAt = 0;
	scrollListener = () => {
		const y = window.scrollY;
		if (Math.abs(y - lastScrollY) > 4) {
			lastScrollAt = Date.now();
			lastScrollY = y;
		}
	};
	window.addEventListener('scroll', scrollListener, { passive: true });
}

function uninstallScrollWatch(): void {
	if (scrollListener) {
		window.removeEventListener('scroll', scrollListener);
		scrollListener = null;
	}
}

/** Catch content that appears later ("show more" comments, lazy sections). */
function watchForNewContent(root: HTMLElement): void {
	if (contentObserver) return;

	contentObserver = new MutationObserver(mutations => {
		let interesting = false;
		for (const mutation of mutations) {
			for (const added of Array.from(mutation.addedNodes)) {
				if (added.nodeType !== Node.ELEMENT_NODE) continue;
				const el = added as HTMLElement;
				if (el.classList.contains('reader-translation') || el.closest('.reader-translation')) continue;
				if (el.matches(BLOCK_SELECTOR) || el.querySelector(BLOCK_SELECTOR)) {
					interesting = true;
					break;
				}
			}
			if (interesting) break;
		}
		if (!interesting) return;

		observeBlocks(discoverBlocks(root));
		scheduleFlush(300);
	});
	contentObserver.observe(root, { childList: true, subtree: true });
}

// --- Settings ------------------------------------------------------------

async function readSettings(): Promise<AiSettings> {
	await loadSettings();
	settings = { ...generalSettings.ai };
	return settings;
}

function missingSetting(ai: AiSettings): string | null {
	if (!ai.enabled) return getMessage('aiDisabled') || 'AI is turned off in settings.';
	if (!ai.baseUrl.trim()) return getMessage('aiMissingBaseUrl') || 'Add an AI base URL in settings first.';
	if (!ai.model.trim()) return getMessage('aiMissingModel') || 'Set an AI model in settings first.';
	if (!ai.apiKey.trim() && !isLocalEndpoint(ai.baseUrl)) {
		return getMessage('aiMissingApiKey') || 'Add an AI API key in settings first.';
	}
	return null;
}

// --- Lifecycle -----------------------------------------------------------

export function createNavButton(doc: Document): HTMLElement {
	const button = doc.createElement('button');
	button.type = 'button';
	button.className = 'obsidian-reader-settings-trigger nav-btn nav-btn-translate';
	button.setAttribute('aria-label', getMessage('aiTranslateButton') || 'Translate');
	button.setAttribute('aria-pressed', 'false');
	// lucide "languages"
	button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		void toggle(doc);
	});
	navButton = button;
	return button;
}

function syncNavButton(): void {
	if (!navButton) return;
	navButton.classList.toggle('is-hidden', !settings?.enabled);
	navButton.classList.toggle('is-active', active);
	navButton.setAttribute('aria-pressed', active ? 'true' : 'false');
}

async function start(doc: Document): Promise<boolean> {
	const ai = await readSettings();

	const missing = missingSetting(ai);
	if (missing) {
		showToast(missing, true);
		return false;
	}

	const root = doc.querySelector('article') as HTMLElement | null;
	if (!root) return false;

	stopObservers();
	observer = createObserver();
	docRef = doc;
	paused = false;
	failures = 0;
	active = true;

	root.classList.add('reader-translate-active');
	root.classList.toggle('reader-translate-replace', ai.mode === 'replacement');

	observeBlocks(discoverBlocks(root));
	watchForNewContent(root);
	installScrollWatch();
	syncNavButton();

	// Prime the runway manually: the first IntersectionObserver callback lands a
	// frame late and the visible paragraphs should not wait for it.
	const runway = window.innerHeight * (VIEWPORT_MARGIN_RATIO + 0.5);
	for (const [el, block] of blocksEntries()) {
		if (isRetryable(block) && distanceFromViewportCenter(el) < runway) {
			queuedBlocks.add(block);
		}
	}
	scheduleFlush(40);
	return true;
}

function blocksEntries(): Array<[HTMLElement, TranslatableBlock]> {
	// WeakMap has no iterator; the DOM is the source of truth for discovery order.
	const doc = docRef;
	if (!doc) return [];
	const entries: Array<[HTMLElement, TranslatableBlock]> = [];
	for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[data-reader-translate-source]'))) {
		const block = blocks.get(el);
		if (block) entries.push([el, block]);
	}
	return entries;
}

function stopObservers(): void {
	if (flushTimer !== null) {
		window.clearTimeout(flushTimer);
		flushTimer = null;
	}
	observer?.disconnect();
	observer = null;
	contentObserver?.disconnect();
	contentObserver = null;
	uninstallScrollWatch();
}

function stop(doc: Document): void {
	active = false;
	paused = false;
	inFlight = 0;
	failures = 0;
	queuedBlocks = new Set();
	setBusy(false);
	stopObservers();

	doc.querySelector('article')?.classList.remove('reader-translate-active', 'reader-translate-replace');
	removeTranslations(doc);

	// Turn it back off and on again: finished blocks are eligible once more,
	// while "nothing to translate" stays out of the queue for good.
	for (const block of discovered) {
		if (block.state === 'done') {
			block.state = 'new';
			block.node = undefined;
			block.attempts = 0;
		}
	}

	syncNavButton();
	doc.querySelector('.reader-translate-toast')?.classList.add('is-hidden');
}

export async function toggle(doc: Document): Promise<boolean> {
	if (active) {
		stop(doc);
		return false;
	}
	return start(doc);
}

/**
 * Called from Reader.apply()/updateReaderContent() once an article exists.
 * Never throws: translation is a bonus feature and must not break Reader.
 */
export async function attach(doc: Document): Promise<void> {
	docRef = doc;
	stop(doc);

	try {
		await readSettings();
	} catch (error) {
		debugLog('Translate', 'Could not read settings:', error);
		return;
	}
	syncNavButton();

	if (settings?.enabled && settings.autoTranslate) {
		await start(doc);
	}
}

/** Called from Reader.teardownContent() before the article is replaced. */
export function detach(doc: Document): void {
	stop(doc);
	discovered = [];
	docRef = null;
}

export function isActive(): boolean {
	return active;
}

export function stats(): { queued: number; inFlight: number; cached: number; active: boolean } {
	let queued = 0;
	for (const block of queuedBlocks) {
		if (isRetryable(block)) queued++;
	}
	return { queued, inFlight, cached: translationCache.sizeValue, active };
}

export const ReaderTranslation = {
	createNavButton,
	attach,
	detach,
	toggle,
	isActive,
	stats,
	extractBlockText
};
