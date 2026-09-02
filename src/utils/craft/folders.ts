// Craft folder tree: local cache, flattening for <select> UIs, and the
// last-used folder remembered per device (same storage tier as
// lastSelectedVault).

import { CraftFolder } from './api';
import { craftFetchFolders } from './client';
import { getLocalStorage, setLocalStorage } from '../storage-utils';

const FOLDER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const FOLDER_CACHE_KEY = 'craftFolderCache';
const LAST_FOLDER_KEY = 'craftLastFolderId';

/** Craft's built-in folders; they are not real clip destinations. */
const HIDDEN_FOLDER_IDS = new Set(['unsorted', 'templates', 'trash']);

export const UNSORTED_FOLDER_ID = 'unsorted';

export interface CraftFolderOption {
	id: string;
	label: string;
}

export interface CraftFolderCacheEntry {
	fetchedAt: number;
	folders: CraftFolder[];
}

export async function getCachedFolderTree(): Promise<CraftFolderCacheEntry | null> {
	const cache = await getLocalStorage(FOLDER_CACHE_KEY) as CraftFolderCacheEntry | undefined;
	if (!cache || !Array.isArray(cache.folders)) return null;
	if (Date.now() - cache.fetchedAt > FOLDER_CACHE_TTL_MS) return null;
	return cache;
}

export async function setCachedFolderTree(folders: CraftFolder[]): Promise<void> {
	const entry: CraftFolderCacheEntry = { fetchedAt: Date.now(), folders };
	await setLocalStorage(FOLDER_CACHE_KEY, entry);
}

export async function clearCachedFolderTree(): Promise<void> {
	await setLocalStorage(FOLDER_CACHE_KEY, null);
}

/**
 * Return the folder tree, using the cache when fresh. Errors from the API are
 * propagated so callers can show a friendly "couldn't load folders" state.
 */
export async function loadCraftFolders(forceRefresh = false): Promise<CraftFolder[]> {
	if (!forceRefresh) {
		const cached = await getCachedFolderTree();
		if (cached) return cached.folders;
	}
	const folders = await craftFetchFolders();
	await setCachedFolderTree(folders);
	return folders;
}

/** Depth-first flatten with "Parent / Child" labels, skipping built-in folders. */
export function flattenCraftFolders(folders: CraftFolder[], prefix = ''): CraftFolderOption[] {
	const options: CraftFolderOption[] = [];

	for (const folder of folders) {
		if (!folder?.id || HIDDEN_FOLDER_IDS.has(folder.id)) continue;
		const label = prefix ? `${prefix} / ${folder.name}` : folder.name;
		options.push({ id: folder.id, label });
		if (folder.folders?.length) {
			options.push(...flattenCraftFolders(folder.folders, label));
		}
	}

	return options;
}

/** Built-in Unsorted first, then the user's folder tree. */
export function buildCraftFolderOptions(
	folders: CraftFolder[],
	unsortedLabel = 'Unsorted'
): CraftFolderOption[] {
	return [
		{ id: UNSORTED_FOLDER_ID, label: unsortedLabel },
		...flattenCraftFolders(folders)
	];
}

export function coerceCraftFolderId(
	folderId: string | null | undefined,
	options: CraftFolderOption[]
): string {
	return options.some(option => option.id === folderId)
		? (folderId as string)
		: UNSORTED_FOLDER_ID;
}

export function getCraftFolderLabel(
	folderId: string | null | undefined,
	options: CraftFolderOption[],
	fallbackLabel = 'Unsorted'
): string {
	if (!folderId || folderId === UNSORTED_FOLDER_ID) return fallbackLabel;
	return options.find(option => option.id === folderId)?.label ?? fallbackLabel;
}

export async function getLastCraftFolderId(): Promise<string | null> {
	const value = await getLocalStorage(LAST_FOLDER_KEY);
	return typeof value === 'string' ? value : null;
}

export async function setLastCraftFolderId(folderId: string): Promise<void> {
	await setLocalStorage(LAST_FOLDER_KEY, folderId);
}
