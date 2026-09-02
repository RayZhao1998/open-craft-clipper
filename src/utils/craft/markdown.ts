// Build the markdown body of a Craft document from what the clipper already
// produces: template properties + note content.
//
// Craft has no YAML frontmatter, so properties become header callouts — the
// same shape the official Craft clipper produces (verified against a real clip
// in the standalone CraftClipper prototype).

import { Property } from '../../types/types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** e.g. "Tue, 7 Jul" */
export function formatSavedDay(date: Date): string {
	return `${DAY_NAMES[date.getDay()]}, ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** e.g. "2026-07-07" (local date — the target of a date:// link) */
export function formatIsoDate(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** e.g. "14:32" (local, 24h) */
export function formatTime(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "Saved [Tue, 7 Jul](date://2026-07-07) at 14:32" */
export function buildSavedCaption(date: Date = new Date()): string {
	return `Saved [${formatSavedDay(date)}](date://${formatIsoDate(date)}) at ${formatTime(date)}`;
}

/**
 * Make text safe inside markdown link syntax `[text](url)`: collapse newlines
 * and escape square brackets so they can't break the link.
 */
export function escapeLinkText(text: string): string {
	return text.replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '\\$&');
}

/** Defensive: a body that still carries YAML frontmatter loses it. */
export function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** One callout per non-empty property: `<callout>**source**: …</callout>`. */
export function propertiesToCallouts(properties: Property[]): string[] {
	const callouts: string[] = [];

	for (const property of properties) {
		const value = (property.value ?? '').trim();
		if (!value) continue;
		callouts.push(`<callout>**${property.name}**: ${value}</callout>`);
	}

	return callouts;
}

/** Split on lines that are nothing but tags/callouts already, keep blanks out. */
function toBlocks(text: string): string[] {
	return text
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(Boolean);
}

export interface CraftDocumentOptions {
	/** Note content (no frontmatter) — what goes below the divider. */
	body: string;
	/** Template properties, rendered as header callouts unless stripped. */
	properties?: Property[];
	/** Pre-rendered custom header (from the headerFormat setting). */
	header?: string;
	/** Tag line for the header, e.g. "#clippings". May be empty. */
	tags?: string;
	propertiesAs?: 'callouts' | 'strip';
	/** Caption timestamp source; defaults to now. */
	now?: Date;
	/** Insert the *** divider between header and body. Defaults to true. */
	divider?: boolean;
}

export function buildCraftDocument({
	body,
	properties = [],
	header = '',
	tags = '',
	propertiesAs = 'callouts',
	now = new Date(),
	divider = true
}: CraftDocumentOptions): string {
	const blocks: string[] = [];
	const trimmedHeader = header.trim();

	if (trimmedHeader) {
		blocks.push(...toBlocks(trimmedHeader));
	} else if (propertiesAs !== 'strip') {
		blocks.push(...propertiesToCallouts(properties));
	}

	const trimmedTags = tags.trim();
	if (trimmedTags) {
		for (const tagLine of trimmedTags.split(/\r?\n/)) {
			if (tagLine.trim()) blocks.push(`<callout>${tagLine.trim()}</callout>`);
		}
	}

	blocks.push(`<callout><caption>${buildSavedCaption(now)}</caption></callout>`);

	const bodyText = stripFrontmatter(body ?? '').trim();
	if (divider && bodyText) {
		blocks.push('***');
		blocks.push(bodyText);
	} else if (bodyText) {
		blocks.push(bodyText);
	}

	return blocks.join('\n\n').trim();
}
