// Obsidian markdown → Craft markdown.
//
// The clipper's templates produce Obsidian flavoured Markdown. Craft renders
// most of it fine, but has no wiki links, no embed syntax, no `%%comments%%`,
// no `==highlight==` and its own callout tag. Everything here is a pure
// function so the conversions can be unit tested in isolation.

export interface CraftSyntaxOptions {
	/** How [[wiki links]] are rendered — Craft has no backlinks. */
	wikilinks?: 'plain' | 'link';
	/** Vault used for obsidian:// search links in "link" mode. */
	vault?: string;
	/** Page URL, used to make relative image URLs absolute. */
	baseUrl?: string;
}

interface Segment {
	code: boolean;
	text: string;
}

/** Split into fenced (```/~~~) and non-fenced segments. */
function splitFencedSegments(markdown: string): Segment[] {
	const segments: Segment[] = [];
	let current: string[] = [];
	let code = false;

	const flush = (isCode: boolean) => {
		if (current.length) segments.push({ code: isCode, text: current.join('\n') });
		current = [];
	};

	for (const line of markdown.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) {
			if (code) {
				current.push(line);
				flush(true);
				code = false;
			} else {
				flush(false);
				code = true;
				current.push(line);
			}
			continue;
		}
		current.push(line);
	}
	flush(code);

	return segments;
}

/** Apply fn to everything outside fenced code blocks (structure preserving). */
export function mapOutsideFences(markdown: string, fn: (text: string) => string): string {
	return splitFencedSegments(markdown)
		.map(segment => (segment.code ? segment.text : fn(segment.text)))
		.join('\n');
}

/** Apply fn outside fenced blocks *and* inline `code` spans (inline rewrites). */
export function mapOutsideCode(markdown: string, fn: (text: string) => string): string {
	return mapOutsideFences(markdown, text =>
		text
			// split() with a capture group alternates: outside, code, outside…
			.split(/(`+[^`\n]*`+)/g)
			.map((part, index) => (index % 2 === 1 ? part : fn(part)))
			.join('')
	);
}

/** `%% hidden %%` comments disappear entirely (may span lines). */
export function removeComments(markdown: string): string {
	return mapOutsideFences(markdown, text =>
		text.replace(/%%[\s\S]*?%%/g, '').replace(/[ \t]{2,}/g, ' ')
	);
}

/** Craft treats `==text==` as a yellow highlight — leave it alone. */
export function convertHighlights(markdown: string): string {
	return markdown;
}

function parseTarget(rawTarget: string): { target: string; alias?: string; heading: string } {
	let [page, alias] = rawTarget.split('|');
	page = (page || '').trim();

	const hashIndex = page.indexOf('#');
	const heading = hashIndex >= 0 ? page.slice(hashIndex + 1).trim() : '';
	if (hashIndex >= 0) page = page.slice(0, hashIndex).trim();

	return { target: page, alias: alias?.trim(), heading };
}

function linkTextFor(target: string, alias: string | undefined, heading: string): string {
	if (alias) return alias;
	if (heading && !target) return heading;
	if (heading) return `${target} → ${heading}`;
	return target;
}

function isImageTarget(target: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|svg|avif|mp4|webm|mp3|wav|ogg|pdf)$/i.test(target);
}

function resolveUrl(target: string, baseUrl?: string): string | null {
	if (!baseUrl) return null;
	try {
		return new URL(target, baseUrl).href;
	} catch {
		return null;
	}
}

export function resolveWikiLink(rawTarget: string, options: CraftSyntaxOptions = {}): string {
	const { target, alias, heading } = parseTarget(rawTarget);
	const text = linkTextFor(target, alias, heading);
	if (!text) return '';

	if ((options.wikilinks ?? 'plain') === 'plain') return text;

	const params = new URLSearchParams();
	if (options.vault) params.set('vault', options.vault);
	params.set('query', target || heading || text);
	return `[${text}](obsidian://search?${params.toString()})`;
}

/**
 * Wiki links and embeds:
 *   [[note]] / [[note|label]] / [[#heading]]  → text or obsidian:// search link
 *   ![[image.png]]                            → ![image.png](absolute url) when resolvable
 *   ![[note]]                                 → dropped (Craft cannot transclude)
 */
export function convertWikiLinks(markdown: string, options: CraftSyntaxOptions = {}): string {
	return mapOutsideCode(markdown, text => {
		// Embeds first: they would otherwise match the plain link pattern.
		let result = text.replace(/!\[\[([^\]]+)\]\]/g, (_match, raw: string) => {
			const { target, alias } = parseTarget(raw);
			if (!target) return '';
			if (!isImageTarget(target)) return '';
			const url = resolveUrl(target, options.baseUrl);
			if (!url) return '';
			return `![${alias || target}](${url})`;
		});

		result = result.replace(/\[\[([^\]]+)\]\]/g, (_match, raw: string) =>
			resolveWikiLink(raw, options)
		);

		// An embed that resolved to nothing can leave "[]" or a blank list item.
		return result.replace(/^-\s*$/gm, '');
	});
}

const CALLOUT_TYPES: Record<string, string> = {
	note: 'Note',
	abstract: 'Summary',
	summary: 'Summary',
	tldr: 'Summary',
	tip: 'Tip',
	hint: 'Tip',
	important: 'Important',
	success: 'Success',
	check: 'Success',
	done: 'Success',
	info: 'Info',
	question: 'Question',
	help: 'Question',
	faq: 'Question',
	warning: 'Warning',
	caution: 'Warning',
	attention: 'Warning',
	failure: 'Failure',
	fail: 'Failure',
	missing: 'Failure',
	danger: 'Danger',
	error: 'Error',
	bug: 'Bug',
	example: 'Example',
	quote: 'Quote',
	cite: 'Quote',
};

/**
 * `> [!tip] Title` blocks → `<callout>Title …body…</callout>`.
 *
 * The whole callout stays one block so the box keeps its body; if Craft's
 * importer ever flattens multi-line callouts this is the single place to
 * change. Callout syntax inside fenced code is left alone.
 */
export function convertCallouts(markdown: string): string {
	return mapOutsideFences(markdown, convertCalloutBlocks);
}

function convertCalloutBlocks(markdown: string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const match = lines[index].match(/^>\s*\[!([A-Za-z-]+)\]([+-]?)\s*(.*)$/);
		if (!match) {
			out.push(lines[index]);
			index++;
			continue;
		}

		const [, type, , rawTitle] = match;
		const title = rawTitle.trim();
		const label = title || CALLOUT_TYPES[type.toLowerCase()] || type;
		const body: string[] = [];
		index++;

		while (index < lines.length && /^>(\s|$)/.test(lines[index])) {
			body.push(lines[index].replace(/^>\s?/, ''));
			index++;
		}

		const trimmedBody = body.join('\n').trim();
		out.push(trimmedBody ? `<callout>${label}\n\n${trimmedBody}</callout>` : `<callout>${label}</callout>`);
		out.push('');
	}

	return out.join('\n');
}

/** Relative image URLs must become absolute — Craft fetches them from its side. */
export function absolutizeImages(markdown: string, baseUrl?: string): string {
	if (!baseUrl) return markdown;

	return mapOutsideCode(markdown, text => {
		let result = text.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (match, prefix: string, src: string, suffix: string) => {
			if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('#') || src.startsWith('data:')) return match;
			const resolved = resolveUrl(src, baseUrl);
			return resolved ? `${prefix}${resolved}${suffix}` : match;
		});

		result = result.replace(/(<img[^>]*\bsrc=["'])([^"']+)(["'])/gi, (match, prefix: string, src: string, suffix: string) => {
			if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('data:')) return match;
			const resolved = resolveUrl(src, baseUrl);
			return resolved ? `${prefix}${resolved}${suffix}` : match;
		});

		return result;
	});
}

/** Collapse whitespace runs left behind by removed embeds/comments. */
function tidy(markdown: string): string {
	return markdown
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Craft's markdown importer rejects lists whose first item is empty
 * ("The first item in any list cannot be empty"). Drop marker-only lines
 * outside fenced code; `***` / `---` horizontal rules are not list items.
 */
export function removeEmptyListItems(markdown: string): string {
	return mapOutsideFences(markdown, text =>
		text.replace(/^( {0,3}(?:[-*+]|\d+[.)])[ \t]*)$/gm, '')
	);
}

// Markdown image, optional title, optional <> around the URL.
const MD_IMAGE = /!\[[^\]]*\]\((?:<[^>\s]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/;
const HTML_IMG = /<img\b[^>]*>/i;
const IMAGE_TOKEN = new RegExp(`(?:${MD_IMAGE.source}|${HTML_IMG.source})`, 'gi');
const LINKED_IMAGE = new RegExp(
	`\\[(${MD_IMAGE.source})\\]\\((?:<[^>\\s]+>|[^\\s)]+)(?:\\s+(?:"[^"]*"|'[^']*'))?\\)`,
	'g'
);

function htmlImgToMarkdown(tag: string): string {
	const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '';
	const src = tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? '';
	return src ? `![${alt}](${src})` : '';
}

function normalizeImageToken(token: string): string {
	return token[0] === '<' ? htmlImgToMarkdown(token) : token;
}

/** `![alt](src)` / `<img>` → `[alt](src)` so it is legal in inline-only Craft tags. */
function imageToLink(token: string): string {
	const markdown = normalizeImageToken(token);
	const match = markdown.match(/^!\[([^\]]*)\]\((.*)\)$/);
	if (!match) return token;
	const alt = match[1].trim() || 'image';
	return `[${alt}](${match[2]})`;
}

function replaceImageTokens(text: string, replacer: (token: string) => string): string {
	IMAGE_TOKEN.lastIndex = 0;
	return text.replace(IMAGE_TOKEN, replacer);
}

/**
 * Craft treats images as blocks, not inline nodes. A clip of a typical article
 * often has `Hello ![x](url)` or `[![x](url)](link)`, which the importer
 * rejects with "Expected inline markdown, got image". Pull those images out
 * onto their own lines (and unwrap linked images) so they parse as blocks.
 *
 * Callouts, captions and highlights are inline-only: an image there becomes a
 * link instead of being split out, so we never break the wrapping tags.
 */
export function promoteImagesToBlocks(markdown: string): string {
	return mapOutsideCode(markdown, text => {
		let result = text.replace(LINKED_IMAGE, '$1');
		result = result.replace(
			/<(callout|caption|highlight)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
			(_full, tag: string, attrs: string, inner: string) =>
				`<${tag}${attrs}>${replaceImageTokens(inner, imageToLink)}</${tag}>`
		);
		return result.split(/\n{2,}/).map(promoteImagesInBlock).join('\n\n');
	});
}

function promoteImagesInBlock(block: string): string {
	IMAGE_TOKEN.lastIndex = 0;
	if (!IMAGE_TOKEN.test(block)) return block;

	const parts: string[] = [];
	let last = 0;
	IMAGE_TOKEN.lastIndex = 0;
	for (const match of block.matchAll(IMAGE_TOKEN)) {
		const index = match.index ?? 0;
		parts.push(block.slice(last, index));
		parts.push(normalizeImageToken(match[0]));
		last = index + match[0].length;
	}
	parts.push(block.slice(last));

	const nonImage = parts.filter((_, index) => index % 2 === 0).join('');
	if (!nonImage.trim()) {
		return parts.filter((part, index) => index % 2 === 1 && part).join('\n\n');
	}

	return parts
		.map(part => part.trim())
		.filter(Boolean)
		.join('\n\n');
}

export function adaptMarkdownForCraft(markdown: string, options: CraftSyntaxOptions = {}): string {
	let result = removeComments(markdown);
	result = convertCallouts(result);
	result = convertWikiLinks(result, options);
	result = convertHighlights(result);
	result = absolutizeImages(result, options.baseUrl);
	result = promoteImagesToBlocks(result);
	result = removeEmptyListItems(result);
	return tidy(result);
}
