// Popup / settings-page facade over the Craft messages handled by the
// background service worker. Keeping the protocol in one file means the UI
// never hand-rolls message shapes.

import browser from '../browser-polyfill';
import { ConnectionInfo, CraftFolder, CraftApiError } from './api';

export interface CraftSavePayload {
	/** Document title (already rendered from the template). */
	title: string;
	/** Final markdown body — exactly what gets written to Craft. */
	markdown: string;
	/** Destination folder id, or null for Unsorted. */
	folderId: string | null;
}

export interface CraftSaveResult {
	documentId: string;
	clickableLink?: string;
}

interface CraftMessageResponse<T> {
	success?: boolean;
	data?: T;
	error?: string;
}

function isExtensionContextLost(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /extension context invalidated/i.test(message)
		|| /message port closed/i.test(message);
}

async function sendCraftMessage<T>(request: Record<string, unknown>): Promise<T> {
	let response: CraftMessageResponse<T> | undefined;
	try {
		response = await browser.runtime.sendMessage(request) as CraftMessageResponse<T> | undefined;
	} catch (error) {
		if (isExtensionContextLost(error)) {
			throw new CraftApiError(0, 'The extension was reloaded. Refresh this page and try again.');
		}
		throw error;
	}
	if (!response || response.success !== true) {
		throw new CraftApiError(0, response?.error || 'Craft request failed.');
	}
	return response.data as T;
}

/** Validate an API link and return the space it points at. */
export function craftTestConnection(apiUrl: string): Promise<ConnectionInfo> {
	return sendCraftMessage<ConnectionInfo>({ action: 'craftTestConnection', apiUrl });
}

/** Always hits the API; folder caching lives in ./folders.ts. */
export function craftFetchFolders(): Promise<CraftFolder[]> {
	return sendCraftMessage<CraftFolder[]>({ action: 'craftGetFolders' });
}

/** Create a document and write the markdown body into it. */
export function craftSave(payload: CraftSavePayload): Promise<CraftSaveResult> {
	return sendCraftMessage<CraftSaveResult>({ action: 'craftSave', ...payload });
}
