// Which app a clip goes to.
//
// Templates can pin a destination; otherwise the global save behavior decides,
// and Craft only wins when it is actually configured. Keeping this decision in
// one tiny function means popup.ts and the reader view can't drift apart.

import { SaveDestination, Settings, Template } from '../types/types';

export type { SaveDestination };

export function isCraftConfigured(settings: Settings | undefined): boolean {
	return Boolean(settings?.craft?.enabled && settings.craft.apiUrl);
}

export function resolveSaveDestination(
	template: Template | null | undefined,
	settings: Settings | undefined
): SaveDestination {
	if (template?.destination === 'obsidian' || template?.destination === 'craft') {
		return template.destination;
	}
	if (!isCraftConfigured(settings)) return 'obsidian';
	return settings!.saveBehavior === 'addToCraft' ? 'craft' : 'obsidian';
}
