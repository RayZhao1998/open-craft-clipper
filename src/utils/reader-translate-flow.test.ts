// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReaderTranslation } from './reader-translate';

// Hoisted so the vi.mock factories below can close over them.
const { aiSettings, translateCalls, control } = vi.hoisted(() => ({
	aiSettings: {
		enabled: true,
		baseUrl: 'https://api.openai.com/v1',
		apiKey: 'sk-test',
		model: 'mini',
		targetLang: 'zh-CN',
		mode: 'bilingual' as 'bilingual' | 'replacement',
		prompt: '',
		translateTranscript: true,
		autoTranslate: true
	},
	translateCalls: [] as string[][],
	control: { fail: false }
}));

vi.mock('./storage-utils', () => ({
	generalSettings: { ai: aiSettings },
	loadSettings: async () => undefined
}));

vi.mock('./i18n', () => ({
	getMessage: (key: string) => key
}));

vi.mock('./ai/messenger', () => ({
	requestTranslations: vi.fn(async (texts: string[]) => {
		translateCalls.push(texts);
		if (control.fail) throw new Error('429 rate limited');
		return texts.map(text => `译文:${text}`);
	}),
	requestAiTest: async () => 'OK'
}));

class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	targets = new Set<Element>();
	rootMargin: string;

	constructor(
		public callback: (entries: unknown[], observer: FakeIntersectionObserver) => void,
		options: { rootMargin?: string } = {}
	) {
		this.rootMargin = options.rootMargin ?? '';
		FakeIntersectionObserver.instances.push(this);
	}

	observe(el: Element) { this.targets.add(el); }
	unobserve(el: Element) { this.targets.delete(el); }
	disconnect() { this.targets.clear(); }
	takeRecords() { return []; }

	fire(entries: Array<{ target: Element; isIntersecting: boolean }>) {
		this.callback(entries, this);
	}
}

function placeAt(el: HTMLElement, top: number) {
	el.getBoundingClientRect = () => ({
		top, bottom: top + 40, left: 0, right: 600, width: 600, height: 40, x: 0, y: top, toJSON() { return {}; }
	}) as DOMRect;
}

let articleId = 0;

function buildArticle(paragraphs: number): HTMLElement {
	document.body.innerHTML = '';
	// Every article gets its own wording: the translation cache is shared across
	// tests in this file, and a reused sentence would be served from cache.
	const uid = ++articleId;
	const main = document.createElement('main');
	const article = document.createElement('article');
	for (let i = 0; i < paragraphs; i++) {
		const p = document.createElement('p');
		p.textContent = `English paragraph ${uid} number ${i}`;
		article.appendChild(p);
	}
	main.appendChild(article);
	document.body.appendChild(main);
	return article;
}

function observers(): FakeIntersectionObserver {
	return FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
	FakeIntersectionObserver.instances = [];
	translateCalls.length = 0;
	control.fail = false;
	Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
	Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function settle() {
	// FLUSH_DELAY (140ms) plus room for the priming timer and promise hops.
	await vi.advanceTimersByTimeAsync(400);
}

describe('ReaderTranslation', () => {
	test('observes everything but only translates the runway around the viewport', async () => {
		const article = buildArticle(30);
		const paragraphs = Array.from(article.querySelectorAll('p'));
		// Paragraphs sit every 100px; the viewport is 400px tall, so the runway
		// (viewport + one screen) reaches roughly the first six paragraphs.
		paragraphs.forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		ReaderTranslation.createNavButton(document);
		await ReaderTranslation.attach(document);
		await settle();

		const observer = observers();
		expect(observer.rootMargin).toBe('400px 0px 400px 0px');
		expect(observer.targets.size).toBe(30);

		const translated = article.querySelectorAll('.reader-translation');
		expect(translated.length).toBe(8);

		// One batched request for the whole runway, not one per paragraph.
		expect(translateCalls.length).toBe(1);
		expect(translateCalls[0].length).toBe(8);
		expect(translated[0].textContent).toBe('译文:English paragraph 1 number 0');
	});

	test('inserts the translation right after its source without touching it', async () => {
		const article = buildArticle(3);
		Array.from(article.querySelectorAll('p')).forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		ReaderTranslation.attach(document);
		await settle();

		const first = article.querySelector('p') as HTMLElement;
		const next = first.nextElementSibling as HTMLElement;

		expect(next.className).toContain('reader-translation');
		expect(next.lang).toBe('zh-CN');
		expect(first.textContent).toBe('English paragraph 2 number 0');
		expect(first.getAttribute('data-reader-translate-source')).toBe('done');
	});

	test('does not spend a request while the page is still scrolling', async () => {
		const article = buildArticle(4);
		Array.from(article.querySelectorAll('p')).forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		await ReaderTranslation.attach(document);

		// A real scroll (the watcher ignores positions that did not move).
		window.scrollY = 160;
		window.dispatchEvent(new Event('scroll'));
		await vi.advanceTimersByTimeAsync(150);
		expect(translateCalls.length).toBe(0);

		await vi.advanceTimersByTimeAsync(800);
		expect(translateCalls.length).toBe(1);
	});

	test('translates more blocks as they scroll into the runway', async () => {
		const article = buildArticle(12);
		const paragraphs = Array.from(article.querySelectorAll<HTMLElement>('p'));
		paragraphs.forEach((p, i) => placeAt(p, i * 100));

		ReaderTranslation.attach(document);
		await settle();

		const before = article.querySelectorAll('.reader-translation').length;

		// Simulate scrolling down: paragraphs 8+ are now the ones being read.
		paragraphs.forEach((p, i) => placeAt(p, (i - 8) * 100));
		observers().fire(paragraphs.slice(8).map(target => ({ target, isIntersecting: true })));
		await settle();

		expect(article.querySelectorAll('.reader-translation').length).toBeGreaterThan(before);
		expect(translateCalls.length).toBeGreaterThan(1);
	});

	test('does not translate code blocks, the nav or the timestamps', async () => {
		document.body.innerHTML = '';
		const article = document.createElement('article');
		article.innerHTML = '<pre><code>const a = 1</code></pre><p>Real prose here</p>';
		const pre = article.querySelector('pre') as HTMLElement;
		const p = article.querySelector('p') as HTMLElement;
		placeAt(pre, 0);
		placeAt(p, 50);
		document.body.appendChild(article);

		ReaderTranslation.attach(document);
		await settle();

		expect(article.querySelectorAll('.reader-translation').length).toBe(1);
		expect(p.nextElementSibling?.textContent).toBe('译文:Real prose here');
		expect(pre.querySelector('.reader-translation')).toBeNull();
	});

	test('skips blocks that are already in the target language', async () => {
		document.body.innerHTML = '';
		const article = document.createElement('article');
		article.innerHTML = '<p>这是一段中文</p><p>English text here</p>';
		const chinese = article.querySelector('p') as HTMLElement;
		const english = article.querySelectorAll('p')[1] as HTMLElement;
		placeAt(chinese, 0);
		placeAt(english, 50);
		document.body.appendChild(article);

		ReaderTranslation.attach(document);
		await settle();

		expect(chinese.getAttribute('data-reader-translate-source')).toBe('skipped');
		expect(english.nextElementSibling?.className).toContain('reader-translation');
		expect(translateCalls[0]).toEqual(['English text here']);
	});

	test('toggling off removes every translation', async () => {
		const article = buildArticle(3);
		Array.from(article.querySelectorAll('p')).forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		await ReaderTranslation.attach(document);
		await settle();
		expect(article.querySelectorAll('.reader-translation').length).toBe(3);

		const turnedOff = await ReaderTranslation.toggle(document);
		expect(turnedOff).toBe(false);
		expect(article.querySelectorAll('.reader-translation').length).toBe(0);
		expect(article.classList.contains('reader-translate-active')).toBe(false);
	});

	test('replacement mode marks the article so CSS can hide the source', async () => {
		aiSettings.mode = 'replacement';
		const article = buildArticle(2);
		Array.from(article.querySelectorAll('p')).forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		await ReaderTranslation.attach(document);
		await settle();

		expect(article.classList.contains('reader-translate-replace')).toBe(true);
		expect(article.querySelectorAll('[data-reader-translate-source="done"]').length).toBe(2);

		aiSettings.mode = 'bilingual';
	});

	test('a failed endpoint stops retrying after a few attempts', async () => {
		control.fail = true;

		// Three long paragraphs: each one is a batch of its own, so the endpoint
		// fails three times in a row and the session must back off.
		const article = buildArticle(3);
		const paragraphs = Array.from(article.querySelectorAll<HTMLElement>('p'));
		paragraphs.forEach((p, i) => {
			p.textContent = `English paragraph ${i}: ` + 'many words to make this one request. '.repeat(45);
			placeAt(p, i * 100);
		});

		await ReaderTranslation.attach(document);
		await vi.advanceTimersByTimeAsync(4000);

		expect(article.querySelectorAll('.reader-translation').length).toBe(0);
		expect(document.querySelector('.reader-translate-toast')?.textContent).toContain('429');

		const calls = translateCalls.length;
		expect(calls).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(4000);
		expect(translateCalls.length).toBe(calls);
	});

	test('covers a YouTube transcript and its description', async () => {
		document.body.innerHTML = '';
		const article = document.createElement('article');
		// Shape of a video page after Reader's transcript post-processing.
		article.innerHTML = [
			'<h2>Transcript</h2>',
			'<div class="transcript">',
			'<div class="transcript-segment" data-transcript-time="0"><span class="transcript-segment-timestamp timestamp">00:00</span><span class="transcript-segment-text">Welcome back to the channel.</span></div>',
			'<div class="transcript-segment" data-transcript-time="5"><span class="transcript-segment-timestamp timestamp">00:05</span><span class="transcript-segment-text">Today we look at tokens.</span></div>',
			'</div>',
			'<h2>Description</h2>',
			'<p>Chapter one of the video<br>Chapter two of the video</p>'
		].join('');
		document.body.appendChild(article);

		const targets = [
			article.querySelector('.transcript-segment-text') as HTMLElement,
			article.querySelectorAll('.transcript-segment-text')[1] as HTMLElement,
			article.querySelector('p') as HTMLElement
		];
		targets.forEach((el, i) => placeAt(el, i * 50));

		await ReaderTranslation.attach(document);
		await settle();

		// The transcript reaches the model line by line, without the timestamps.
		const sent = translateCalls.flat();
		expect(sent).toContain('Welcome back to the channel.');
		expect(sent.some(text => text.includes('Chapter one'))).toBe(true);
		expect(sent.some(text => text.includes('00:00'))).toBe(false);
		// ...and the description keeps its two lines in one request.
		expect(sent.some(text => text.includes('\n'))).toBe(true);

		// A translation span is inserted inside the segment, next to the original
		// text: the player measures those segments, so their rects must not move.
		const first = targets[0];
		const inserted = first.parentElement?.querySelector('.reader-translation');
		expect(inserted?.textContent).toBe('译文:Welcome back to the channel.');
		expect(first.textContent).toBe('Welcome back to the channel.');
		expect(article.querySelector('.timestamp')?.parentElement?.className).toBe('transcript-segment');
	});

	test('leaves the transcript alone when captions are switched off', async () => {
		aiSettings.translateTranscript = false;
		document.body.innerHTML = '';
		const article = document.createElement('article');
		article.innerHTML = [
			'<div class="transcript">',
			'<div class="transcript-segment"><span class="transcript-segment-timestamp timestamp">00:00</span><span class="transcript-segment-text">Spoken words here.</span></div>',
			'</div>',
			'<p>Description text here</p>'
		].join('');
		document.body.appendChild(article);

		const spoken = article.querySelector('.transcript-segment-text') as HTMLElement;
		const description = article.querySelector('p') as HTMLElement;
		placeAt(spoken, 0);
		placeAt(description, 50);

		await ReaderTranslation.attach(document);
		await settle();

		expect(translateCalls.flat()).toEqual(['Description text here']);
		expect(spoken.parentElement?.querySelector('.reader-translation')).toBeNull();
		expect(description.nextElementSibling?.className).toContain('reader-translation');

		aiSettings.translateTranscript = true;
	});

	test('detach() cleans up for the next article', async () => {
		const article = buildArticle(2);
		Array.from(article.querySelectorAll('p')).forEach((p, i) => placeAt(p as HTMLElement, i * 100));

		await ReaderTranslation.attach(document);
		await settle();
		ReaderTranslation.detach(document);

		expect(article.querySelectorAll('.reader-translation').length).toBe(0);
		expect(ReaderTranslation.isActive()).toBe(false);
	});
});
