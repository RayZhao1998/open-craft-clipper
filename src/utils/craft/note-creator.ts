// Craft counterpart of utils/obsidian-note-creator.ts: turn the clipper's
// properties + note content into a Craft document.

import { CraftSettings, Property } from '../../types/types';
import { CraftApiError } from './api';
import { craftSave, CraftSaveResult } from './client';
import { buildCraftDocument, propertyValueText } from './markdown';
import { adaptMarkdownForCraft, promoteImagesToBlocks } from './syntax';
import { getMessage } from '../i18n';

export interface CraftClipInput {
	/** Craft document title. */
	title: string;
	/** Note content as shown in the clipper (no frontmatter). */
	body: string;
	properties: Property[];
	/** Destination folder id, or null for Unsorted. */
	folderId: string | null;
	craft: CraftSettings;
	/**
	 * Header rendered from the headerFormat setting. When empty the built-in
	 * property callouts are used. Rendering happens in the popup because the
	 * template engine needs the page variables.
	 */
	header?: string;
	/** Page URL — lets relative images become absolute. */
	sourceUrl?: string;
	/** Vault used when [[wiki links]] become obsidian:// search links. */
	vault?: string;
}

export async function saveToCraft({
	title,
	body,
	properties,
	folderId,
	craft,
	header = '',
	sourceUrl = '',
	vault = ''
}: CraftClipInput): Promise<CraftSaveResult> {
	if (!craft.apiUrl) {
		throw new CraftApiError(0, getMessage('craftNotConfigured'));
	}

	const syntaxOptions = {
		wikilinks: craft.wikilinks,
		vault,
		baseUrl: sourceUrl || undefined
	};

	// Run image promotion on the assembled document too: property callouts
	// wrap values on one line, which would put `![...](...)` back into an
	// inline context and Craft rejects that ("Expected inline markdown, got image").
	const markdown = promoteImagesToBlocks(buildCraftDocument({
		body: adaptMarkdownForCraft(body, syntaxOptions),
		properties: properties.map(property => {
			const value = propertyValueText(property.value);
			return {
				...property,
				value: value ? adaptMarkdownForCraft(value, syntaxOptions) : value
			};
		}),
		header,
		tags: craft.tags,
		propertiesAs: craft.propertiesAs
	}));

	return craftSave({
		title: title.trim() || 'Untitled clip',
		markdown,
		folderId
	});
}
