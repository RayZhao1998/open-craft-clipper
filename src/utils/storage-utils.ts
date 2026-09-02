import browser from './browser-polyfill';
import { Settings, ModelConfig, PropertyType, HistoryEntry, Provider, Rating, CraftSettings, SaveBehavior, AiSettings } from '../types/types';
import { debugLog } from './debug';

export type { Settings, ModelConfig, PropertyType, HistoryEntry, Provider, Rating, CraftSettings, SaveBehavior, AiSettings };

export const defaultCraftSettings: CraftSettings = {
	enabled: false,
	apiUrl: '',
	defaultFolderId: 'unsorted',
	propertiesAs: 'callouts',
	headerFormat: '',
	tags: '#clippings',
	wikilinks: 'plain'
};

export const defaultAiSettings: AiSettings = {
	enabled: false,
	baseUrl: '',
	apiKey: '',
	model: '',
	extraParams: '',
	targetLang: 'zh-CN',
	mode: 'bilingual',
	prompt: '',
	translateTranscript: true,
	autoTranslate: false
};

export let generalSettings: Settings = {
	vaults: [],
	betaFeatures: false,
	legacyMode: false,
	silentOpen: false,
	openBehavior: 'popup',
	highlighterEnabled: true,
	alwaysShowHighlights: false,
	highlightBehavior: 'highlight-inline',
	showMoreActionsButton: false,
	interpreterModel: '',
	models: [],
	providers: [],
	interpreterEnabled: false,
	interpreterAutoRun: false,
	defaultPromptContext: '',
	propertyTypes: [],
	readerSettings: {
		fontSize: 16,
		lineHeight: 1.6,
		maxWidth: 38,
		lightTheme: 'default',
		darkTheme: 'same',
		appearance: 'auto',
		fonts: [],
		defaultFont: '',
		blendImages: true,
		colorLinks: false,
		followLinks: true,
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		customCss: ''
	},
	stats: {
		addToObsidian: 0,
		addToCraft: 0,
		saveFile: 0,
		copyToClipboard: 0,
		share: 0,
		readerMode: 0
	},
	history: [],
	ratings: [],
	craft: { ...defaultCraftSettings },
	ai: { ...defaultAiSettings },
	saveBehavior: 'addToObsidian'
};

export function setLocalStorage(key: string, value: any): Promise<void> {
	return browser.storage.local.set({ [key]: value });
}

export function getLocalStorage(key: string): Promise<any> {
	return browser.storage.local.get(key).then((result: {[key: string]: any}) => result[key]);
}

interface StorageData {
	general_settings?: {
		showMoreActionsButton?: boolean;
		betaFeatures?: boolean;
		legacyMode?: boolean;
		silentOpen?: boolean;
		openBehavior?: boolean | 'popup' | 'embedded';
		saveBehavior?: SaveBehavior;
	};
	craft_settings?: {
		enabled?: boolean;
		apiUrl?: string;
		defaultFolderId?: string;
		propertiesAs?: 'callouts' | 'strip';
		headerFormat?: string;
		tags?: string;
		wikilinks?: 'plain' | 'link';
	};
	ai_settings?: {
		enabled?: boolean;
		baseUrl?: string;
		apiKey?: string;
		model?: string;
		extraParams?: string;
		targetLang?: string;
		mode?: 'bilingual' | 'replacement';
		prompt?: string;
		translateTranscript?: boolean;
		autoTranslate?: boolean;
	};
	vaults?: string[];
	highlighter_settings?: {
		highlighterEnabled?: boolean;
		alwaysShowHighlights?: boolean;
		highlightBehavior?: string;
	};
	reader_settings?: {
		fontSize?: number;
		lineHeight?: number;
		maxWidth?: number;
		lightTheme?: string;
		darkTheme?: string;
		appearance?: 'auto' | 'light' | 'dark';
		fonts?: string[];
		defaultFont?: string;
		blendImages?: boolean;
		colorLinks?: boolean;
		followLinks?: boolean;
		pinPlayer?: boolean;
		autoScroll?: boolean;
		highlightActiveLine?: boolean;
		customCss?: string;
	};
	interpreter_settings?: {
		interpreterModel?: string;
		models?: ModelConfig[];
		providers?: Provider[];
		interpreterEnabled?: boolean;
		interpreterAutoRun?: boolean;
		defaultPromptContext?: string;
	};
	property_types?: PropertyType[];
	stats?: {
		addToObsidian: number;
		addToCraft?: number;
		saveFile: number;
		copyToClipboard: number;
		share: number;
		readerMode?: number;
	};
	history?: HistoryEntry[];
	ratings?: Rating[];
	migrationVersion?: number;
}

const CURRENT_MIGRATION_VERSION = 1;

// Storage is user-editable (and synced), so every AI field is coerced: a stray
// number in baseUrl or a non-string apiKey must never reach fetch().
function sanitizeAiSettings(stored: StorageData['ai_settings'] | undefined, fallback: AiSettings): AiSettings {
	const text = (value: unknown, or: string): string => (typeof value === 'string' ? value : or);
	const flag = (value: unknown, or: boolean): boolean => (typeof value === 'boolean' ? value : or);

	return {
		enabled: flag(stored?.enabled, fallback.enabled),
		baseUrl: text(stored?.baseUrl, fallback.baseUrl).trim(),
		apiKey: text(stored?.apiKey, fallback.apiKey).trim(),
		model: text(stored?.model, fallback.model).trim(),
		extraParams: text(stored?.extraParams, fallback.extraParams).trim().slice(0, 4000),
		targetLang: text(stored?.targetLang, fallback.targetLang).trim() || fallback.targetLang,
		mode: stored?.mode === 'replacement' ? 'replacement' : (stored?.mode === 'bilingual' ? 'bilingual' : fallback.mode),
		prompt: text(stored?.prompt, fallback.prompt),
		translateTranscript: flag(stored?.translateTranscript, fallback.translateTranscript),
		autoTranslate: flag(stored?.autoTranslate, fallback.autoTranslate)
	};
}

export async function loadSettings(): Promise<Settings> {
	const data = await browser.storage.sync.get(null) as StorageData;
	
	// Load default settings first
	const defaultSettings: Settings = {
		vaults: [],
		showMoreActionsButton: false,
		betaFeatures: false,
		legacyMode: false,
		silentOpen: false,
		openBehavior: 'popup',
		highlighterEnabled: true,
		alwaysShowHighlights: true,
		highlightBehavior: 'highlight-inline',
		interpreterModel: '',
		models: [],
		providers: [],
		interpreterEnabled: false,
		interpreterAutoRun: false,
		defaultPromptContext: '',
		propertyTypes: [],
		saveBehavior: 'addToObsidian',
		readerSettings: {
			fontSize: 16,
			lineHeight: 1.6,
			maxWidth: 38,
			lightTheme: 'default',
			darkTheme: 'same',
			appearance: 'auto',
			fonts: [],
			defaultFont: '',
			blendImages: true,
			colorLinks: false,
			followLinks: true,
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			customCss: ''
		},
		stats: {
			addToObsidian: 0,
			addToCraft: 0,
			saveFile: 0,
			copyToClipboard: 0,
			share: 0,
			readerMode: 0
		},
		history: [],
		ratings: [],
		craft: { ...defaultCraftSettings },
		ai: { ...defaultAiSettings },
	};

	// Update migration version if needed
	if (!data.migrationVersion || data.migrationVersion < CURRENT_MIGRATION_VERSION) {
		await browser.storage.sync.set({ migrationVersion: CURRENT_MIGRATION_VERSION });
		debugLog('Settings', `Updated migration version to ${CURRENT_MIGRATION_VERSION}`);
	}

	// Validate and sanitize data to prevent corruption
	const sanitizedVaults = Array.isArray(data.vaults) ? data.vaults.filter(v => typeof v === 'string') : [];
	const sanitizedModels = Array.isArray(data.interpreter_settings?.models) 
		? data.interpreter_settings.models.filter(m => m && typeof m === 'object' && typeof m.id === 'string') 
		: [];
	const sanitizedProviders = Array.isArray(data.interpreter_settings?.providers) 
		? data.interpreter_settings.providers.filter(p => p && typeof p === 'object' && typeof p.id === 'string') 
		: [];

	// Load user settings
	const loadedSettings: Settings = {
		vaults: sanitizedVaults.length > 0 ? sanitizedVaults : defaultSettings.vaults,
		showMoreActionsButton: data.general_settings?.showMoreActionsButton ?? defaultSettings.showMoreActionsButton,
		betaFeatures: data.general_settings?.betaFeatures ?? defaultSettings.betaFeatures,
		legacyMode: data.general_settings?.legacyMode ?? defaultSettings.legacyMode,
		silentOpen: data.general_settings?.silentOpen ?? defaultSettings.silentOpen,
		openBehavior: typeof data.general_settings?.openBehavior === 'boolean' 
			? (data.general_settings.openBehavior ? 'embedded' : 'popup') 
			: (data.general_settings?.openBehavior ?? defaultSettings.openBehavior),
		highlighterEnabled: data.highlighter_settings?.highlighterEnabled ?? defaultSettings.highlighterEnabled,
		alwaysShowHighlights: data.highlighter_settings?.alwaysShowHighlights ?? defaultSettings.alwaysShowHighlights,
		highlightBehavior: data.highlighter_settings?.highlightBehavior ?? defaultSettings.highlightBehavior,
		interpreterModel: data.interpreter_settings?.interpreterModel || defaultSettings.interpreterModel,
		models: sanitizedModels,
		providers: sanitizedProviders,
		interpreterEnabled: data.interpreter_settings?.interpreterEnabled ?? defaultSettings.interpreterEnabled,
		interpreterAutoRun: data.interpreter_settings?.interpreterAutoRun ?? defaultSettings.interpreterAutoRun,
		defaultPromptContext: data.interpreter_settings?.defaultPromptContext || defaultSettings.defaultPromptContext,
		propertyTypes: data.property_types || defaultSettings.propertyTypes,
		readerSettings: {
			fontSize: data.reader_settings?.fontSize ?? defaultSettings.readerSettings.fontSize,
			lineHeight: data.reader_settings?.lineHeight ?? defaultSettings.readerSettings.lineHeight,
			maxWidth: data.reader_settings?.maxWidth ?? defaultSettings.readerSettings.maxWidth,
			lightTheme: data.reader_settings?.lightTheme ?? defaultSettings.readerSettings.lightTheme,
			darkTheme: data.reader_settings?.darkTheme ?? defaultSettings.readerSettings.darkTheme,
			appearance: data.reader_settings?.appearance as 'auto' | 'light' | 'dark' ?? defaultSettings.readerSettings.appearance,
			fonts: data.reader_settings?.fonts ?? defaultSettings.readerSettings.fonts,
			defaultFont: data.reader_settings?.defaultFont ?? defaultSettings.readerSettings.defaultFont,
			blendImages: data.reader_settings?.blendImages ?? defaultSettings.readerSettings.blendImages,
			colorLinks: data.reader_settings?.colorLinks ?? defaultSettings.readerSettings.colorLinks,
			followLinks: data.reader_settings?.followLinks ?? defaultSettings.readerSettings.followLinks,
			pinPlayer: data.reader_settings?.pinPlayer ?? defaultSettings.readerSettings.pinPlayer,
			autoScroll: data.reader_settings?.autoScroll ?? defaultSettings.readerSettings.autoScroll,
			highlightActiveLine: data.reader_settings?.highlightActiveLine ?? defaultSettings.readerSettings.highlightActiveLine,
			customCss: data.reader_settings?.customCss ?? defaultSettings.readerSettings.customCss
		},
		stats: { ...defaultSettings.stats, ...data.stats },
		history: data.history || defaultSettings.history,
		ratings: data.ratings || defaultSettings.ratings,
		craft: {
			enabled: data.craft_settings?.enabled ?? defaultCraftSettings.enabled,
			apiUrl: typeof data.craft_settings?.apiUrl === 'string' ? data.craft_settings.apiUrl : defaultCraftSettings.apiUrl,
			defaultFolderId: typeof data.craft_settings?.defaultFolderId === 'string' && data.craft_settings.defaultFolderId
				? data.craft_settings.defaultFolderId
				: defaultCraftSettings.defaultFolderId,
			propertiesAs: data.craft_settings?.propertiesAs === 'strip'
				? 'strip'
				: (data.craft_settings?.propertiesAs === 'callouts' ? 'callouts' : defaultCraftSettings.propertiesAs),
			headerFormat: typeof data.craft_settings?.headerFormat === 'string' ? data.craft_settings.headerFormat : defaultCraftSettings.headerFormat,
			tags: typeof data.craft_settings?.tags === 'string' ? data.craft_settings.tags : defaultCraftSettings.tags,
			wikilinks: data.craft_settings?.wikilinks === 'link'
				? 'link'
				: (data.craft_settings?.wikilinks === 'plain' ? 'plain' : defaultCraftSettings.wikilinks)
		},
		ai: sanitizeAiSettings(data.ai_settings, defaultSettings.ai),
		saveBehavior: data.general_settings?.saveBehavior ?? defaultSettings.saveBehavior
	};

	generalSettings = loadedSettings;
	debugLog('Settings', 'Loaded settings:', generalSettings);
	return generalSettings;
}

export async function saveSettings(settings?: Partial<Settings>): Promise<void> {
	if (settings) {
		generalSettings = { ...generalSettings, ...settings };
	}

	await browser.storage.sync.set({
		vaults: generalSettings.vaults,
		general_settings: {
			showMoreActionsButton: generalSettings.showMoreActionsButton,
			betaFeatures: generalSettings.betaFeatures,
			legacyMode: generalSettings.legacyMode,
			silentOpen: generalSettings.silentOpen,
			openBehavior: generalSettings.openBehavior,
			saveBehavior: generalSettings.saveBehavior,
		},
		highlighter_settings: {
			highlighterEnabled: generalSettings.highlighterEnabled,
			alwaysShowHighlights: generalSettings.alwaysShowHighlights,
			highlightBehavior: generalSettings.highlightBehavior
		},
		interpreter_settings: {
			interpreterModel: generalSettings.interpreterModel,
			models: generalSettings.models,
			providers: generalSettings.providers,
			interpreterEnabled: generalSettings.interpreterEnabled,
			interpreterAutoRun: generalSettings.interpreterAutoRun,
			defaultPromptContext: generalSettings.defaultPromptContext
		},
		property_types: generalSettings.propertyTypes,
		craft_settings: {
			enabled: generalSettings.craft.enabled,
			apiUrl: generalSettings.craft.apiUrl,
			defaultFolderId: generalSettings.craft.defaultFolderId,
			propertiesAs: generalSettings.craft.propertiesAs,
			headerFormat: generalSettings.craft.headerFormat,
			tags: generalSettings.craft.tags,
			wikilinks: generalSettings.craft.wikilinks
		},
		ai_settings: {
			enabled: generalSettings.ai.enabled,
			baseUrl: generalSettings.ai.baseUrl,
			apiKey: generalSettings.ai.apiKey,
			model: generalSettings.ai.model,
			extraParams: generalSettings.ai.extraParams,
			targetLang: generalSettings.ai.targetLang,
			mode: generalSettings.ai.mode,
			prompt: generalSettings.ai.prompt,
			translateTranscript: generalSettings.ai.translateTranscript,
			autoTranslate: generalSettings.ai.autoTranslate
		},
		reader_settings: {
			fontSize: generalSettings.readerSettings.fontSize,
			lineHeight: generalSettings.readerSettings.lineHeight,
			maxWidth: generalSettings.readerSettings.maxWidth,
			lightTheme: generalSettings.readerSettings.lightTheme,
			darkTheme: generalSettings.readerSettings.darkTheme,
			appearance: generalSettings.readerSettings.appearance,
			fonts: generalSettings.readerSettings.fonts,
			defaultFont: generalSettings.readerSettings.defaultFont,
			blendImages: generalSettings.readerSettings.blendImages,
			colorLinks: generalSettings.readerSettings.colorLinks,
			followLinks: generalSettings.readerSettings.followLinks,
			pinPlayer: generalSettings.readerSettings.pinPlayer,
			autoScroll: generalSettings.readerSettings.autoScroll,
			highlightActiveLine: generalSettings.readerSettings.highlightActiveLine,
			customCss: generalSettings.readerSettings.customCss
		},
		stats: generalSettings.stats
	});
}

export async function setLegacyMode(enabled: boolean): Promise<void> {
	await saveSettings({ legacyMode: enabled });
	console.log(`Legacy mode ${enabled ? 'enabled' : 'disabled'}`);
}

export async function incrementStat(
	action: keyof Settings['stats'],
	vault?: string,
	path?: string,
	url?: string,
	title?: string
): Promise<void> {
	const settings = await loadSettings();
	settings.stats[action]++;
	await saveSettings(settings);

	// Add history entry if URL is provided
	if (url) {
		await addHistoryEntry(action, url, title, vault, path);
	}
}

export async function addHistoryEntry(
	action: keyof Settings['stats'], 
	url: string, 
	title?: string,
	vault?: string,
	path?: string
): Promise<void> {
	const entry: HistoryEntry = {
		datetime: new Date().toISOString(),
		url,
		action,
		title,
		vault,
		path
	};

	// Get existing history from local storage
	const result = await browser.storage.local.get('history');
	const history: HistoryEntry[] = (result.history || []) as HistoryEntry[];

	// Add new entry at the beginning
	history.unshift(entry);

	// Keep only the last 1000 entries
	const trimmedHistory = history.slice(0, 1000);

	// Save back to local storage
	await browser.storage.local.set({ history: trimmedHistory });
}

export async function getClipHistory(): Promise<HistoryEntry[]> {
	const result = await browser.storage.local.get('history');
	return (result.history || []) as HistoryEntry[];
}

declare global {
	interface Window {
		debugStorage: (key?: string) => Promise<Record<string, unknown>>;
	}
}

// Make storage accessible from console — use `window.debugStorage()` to see all sync storage, or `window.debugStorage(key)` to see a specific key
if (typeof window !== 'undefined') {
	window.debugStorage = (key?: string) => {
		if (key) {
			return browser.storage.sync.get(key).then(data => {
				console.log(`Sync storage contents for key "${key}":`, data);
				return data;
			});
		}
		return browser.storage.sync.get(null).then(data => {
			console.log('Sync storage contents:', data);
			return data;
		});
	};
}
