// Craft Space API client.
//
// All network calls are made from the background service worker (see
// src/background.ts) so page CSP/CORS never gets in the way. The secret link
// itself is the credential — no extra auth header is sent, which is why the
// link must never be logged (see maskSecretLink).
//
// Ported from the standalone CraftClipper prototype (src/lib/craft.ts).

export const DEFAULT_CRAFT_CONNECT_BASE = 'https://connect.craft.do';

const LINK_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface ConnectionInfo {
	space: {
		id: string;
		name: string;
		timezone?: string;
		time?: string;
		friendlyDate?: string;
	};
}

export interface CraftFolder {
	id: string;
	name: string;
	documentCount: number;
	folders: CraftFolder[];
}

export interface CreatedDocument {
	id: string;
	title: string;
	clickableLink?: string;
}

/**
 * Normalize whatever the user pasted into the settings page into the
 * canonical `https://connect.craft.do/links/<id>/api/v1` base URL.
 *
 * Accepts:
 *   - a full API URL:      https://connect.craft.do/links/<id>/api/v1
 *   - a share-link URL:    https://connect.craft.do/links/<id>
 *   - a bare link id:      <id>
 */
export function normalizeApiUrl(input: string, connectBase: string = DEFAULT_CRAFT_CONNECT_BASE): string {
	const trimmed = input.trim().replace(/\/+$/, '');
	if (!trimmed) {
		throw new CraftApiError(0, 'Enter your Craft Space API link.');
	}

	const base = connectBase.replace(/\/+$/, '');
	const host = base.replace(/^https?:\/\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	const fullMatch = trimmed.match(
		new RegExp(`^https?://${host}/links/([^/]+)(?:/api/v1)?$`, 'i')
	);
	if (fullMatch) {
		return `${base}/links/${fullMatch[1]}/api/v1`;
	}

	if (LINK_ID_RE.test(trimmed)) {
		return `${base}/links/${trimmed}/api/v1`;
	}

	throw new CraftApiError(
		0,
		"That doesn't look like a Craft Space API link. Paste the full link or just its id."
	);
}

/**
 * Replace the secret link id in a string so it is safe to log or show in an
 * error message. Keeps enough of the id to recognize which link is meant.
 */
export function maskSecretLink(value: string): string {
	return value.replace(/links\/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]*/g, (_match, head) =>
		`links/${head}****`
	);
}

export class CraftApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'CraftApiError';
		this.status = status;
	}
}

export function toCraftErrorMessage(error: unknown): string {
	if (error instanceof CraftApiError) return maskSecretLink(error.message);
	if (error instanceof Error) return maskSecretLink(error.message);
	return maskSecretLink(String(error));
}

async function request<T>(apiUrl: string, path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${apiUrl}${path}`, {
			...init,
			headers: {
				'content-type': 'application/json',
				...(init?.headers ?? {})
			}
		});
	} catch {
		throw new CraftApiError(0, 'Could not reach Craft. Check your internet connection.');
	}

	const text = await response.text();
	const parsed = parseJsonBody(text);

	if (!response.ok) {
		const detail = (parsed && (parsed.message || parsed.error)) || '';

		if (response.status === 401 || response.status === 404) {
			throw new CraftApiError(
				response.status,
				'Craft rejected the request — check your API link in settings.'
			);
		}
		throw new CraftApiError(response.status, detail || `Craft API request failed (${response.status}).`);
	}

	// POST /blocks can return 200 with an empty body after a successful insert.
	return parsed as T;
}

function parseJsonBody(text: string): any {
	if (!text.trim()) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export async function getConnection(apiUrl: string): Promise<ConnectionInfo> {
	return request<ConnectionInfo>(apiUrl, '/connection', { method: 'GET' });
}

export async function getFolders(apiUrl: string): Promise<CraftFolder[]> {
	const data = await request<{ items: CraftFolder[] }>(apiUrl, '/folders', { method: 'GET' });
	return data.items ?? [];
}

export async function createDocument(
	apiUrl: string,
	title: string,
	folderId: string | null
): Promise<CreatedDocument> {
	const body: Record<string, unknown> = { documents: [{ title }] };
	if (folderId && folderId !== 'unsorted') {
		body.destination = { folderId };
	}

	const data = await request<{ items: CreatedDocument[] }>(apiUrl, '/documents', {
		method: 'POST',
		body: JSON.stringify(body)
	});

	const doc = data.items?.[0];
	if (!doc) {
		throw new CraftApiError(0, 'Craft did not return a created document.');
	}
	return doc;
}

export async function deleteDocuments(apiUrl: string, documentIds: string[]): Promise<void> {
	if (!documentIds.length) return;
	await request(apiUrl, '/documents', {
		method: 'DELETE',
		body: JSON.stringify({ documentIds })
	});
}

/**
 * Create a document and write its body. If the body write fails, the empty
 * document is moved to Trash so Craft is not left with a title-only clip.
 */
export async function createDocumentWithMarkdown(
	apiUrl: string,
	title: string,
	markdown: string,
	folderId: string | null
): Promise<CreatedDocument> {
	const created = await createDocument(apiUrl, title, folderId);
	if (!markdown.trim()) return created;
	try {
		await appendMarkdown(apiUrl, created.id, markdown);
		return created;
	} catch (error) {
		await deleteDocuments(apiUrl, [created.id]).catch(() => {});
		throw error;
	}
}

/** Max size (in bytes, UTF-8) of a single POST /blocks markdown payload. */
export const MAX_CHUNK_BYTES = 100_000;

/**
 * Split markdown into chunks at blank-line boundaries so no single
 * `POST /blocks` body exceeds ~100KB, then insert them sequentially
 * (preserving order) at the end of the document.
 */
export async function appendMarkdown(
	apiUrl: string,
	pageId: string,
	markdown: string,
	maxChunkBytes: number = MAX_CHUNK_BYTES
): Promise<void> {
	const chunks = splitMarkdownIntoChunks(markdown, maxChunkBytes);
	for (const chunk of chunks) {
		if (!chunk.trim()) continue;
		const result = await request(apiUrl, '/blocks', {
			method: 'POST',
			body: JSON.stringify({
				markdown: chunk,
				position: { position: 'end', pageId }
			})
		});
		if (result == null) {
			throw new CraftApiError(0, 'Craft did not confirm the content was saved.');
		}
	}
}

/**
 * Split markdown into blocks at blank-line boundaries, but never inside a
 * fenced code block (``` or ~~~): a fence containing blank lines must stay
 * atomic within one chunk, or chunked requests would corrupt it.
 */
export function splitIntoBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;

	const flush = () => {
		if (current.length > 0) {
			blocks.push(current.join('\n'));
			current = [];
		}
	};

	for (const line of markdown.split('\n')) {
		if (!inFence && line.trim() === '') {
			// Blank line outside a fence = block boundary (runs of blanks collapse).
			flush();
			continue;
		}
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
		}
		current.push(line);
	}
	flush();

	return blocks;
}

export function splitMarkdownIntoChunks(markdown: string, maxBytes: number): string[] {
	const byteLength = (s: string) => new TextEncoder().encode(s).length;

	if (byteLength(markdown) <= maxBytes) return [markdown];

	const blocks = splitIntoBlocks(markdown);
	const chunks: string[] = [];
	let current = '';

	for (const block of blocks) {
		const candidate = current ? `${current}\n\n${block}` : block;
		if (current && byteLength(candidate) > maxBytes) {
			chunks.push(current);
			current = block;
		} else {
			current = candidate;
		}
	}
	if (current) chunks.push(current);

	// A single block bigger than maxBytes is sent as-is; Craft accepts large
	// single markdown bodies, we just lose the ability to sub-chunk it.
	return chunks.length ? chunks : [markdown];
}
