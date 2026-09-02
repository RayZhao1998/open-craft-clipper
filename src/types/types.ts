export interface Template {
	id: string;
	name: string;
	behavior: 'create' | 'append-specific' | 'append-daily' | 'prepend-specific' | 'prepend-daily' | 'overwrite';
	noteNameFormat: string;
	path: string;
	noteContentFormat: string;
	properties: Property[];
	triggers?: string[];
	vault?: string;
	context?: string;
	/**
	 * Where this template saves. When unset, the global default
	 * (Settings.saveBehavior) decides, so existing templates keep working.
	 */
	destination?: SaveDestination;
}

export interface Property {
	id?: string;
	name: string;
	value: string;
	type?: string;
}

export interface ExtractedContent {
	[key: string]: string;
}

export interface PromptVariable {
	key: string;
	prompt: string;
	filters?: string;
}

export interface PropertyType {
	name: string;
	type: string;
	defaultValue?: string;
}

export interface Provider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiKeyRequired?: boolean;
	presetId?: string;
}

export interface Rating {
	rating: number;
	date: string;
}

export type SaveDestination = 'obsidian' | 'craft';

export type SaveBehavior = 'addToObsidian' | 'addToCraft' | 'saveFile' | 'copyToClipboard';

export interface CraftSettings {
	enabled: boolean;
	/** Canonical Space API base URL, e.g. https://connect.craft.do/links/<id>/api/v1 */
	apiUrl: string;
	/** Destination folder id used when a template doesn't override it. */
	defaultFolderId: string;
	/** Render template properties as Craft callouts above the body, or drop them. */
	propertiesAs: 'callouts' | 'strip';
	/** Optional custom header, rendered with the template engine. Empty = built-in callouts. */
	headerFormat: string;
	/** Tag line inserted in the header, e.g. "#clippings". */
	tags: string;
	/** How [[wikilinks]] survive in Craft, which has no backlinks. */
	wikilinks: 'plain' | 'link';
}

export interface ReaderSettings {
	fontSize: number;
	lineHeight: number;
	maxWidth: number;
	lightTheme: string;
	darkTheme: string;
	appearance: 'auto' | 'light' | 'dark';
	fonts: string[];
	defaultFont: string;
	blendImages: boolean;
	colorLinks: boolean;
	followLinks: boolean;
	pinPlayer: boolean;
	autoScroll: boolean;
	highlightActiveLine: boolean;
	customCss: string;
}

export interface Settings {
	vaults: string[];
	showMoreActionsButton: boolean;
	betaFeatures: boolean;
	legacyMode: boolean;
	silentOpen: boolean;
	openBehavior: 'popup' | 'embedded' | 'reader';
	highlighterEnabled: boolean;
	alwaysShowHighlights: boolean;
	highlightBehavior: string;
	interpreterModel?: string;
	models: ModelConfig[];
	providers: Provider[];
	interpreterEnabled: boolean;
	interpreterAutoRun: boolean;
	defaultPromptContext: string;
	propertyTypes: PropertyType[];
	readerSettings: ReaderSettings;
	craft: CraftSettings;
	stats: {
		addToObsidian: number;
		addToCraft: number;
		saveFile: number;
		copyToClipboard: number;
		share: number;
		readerMode: number;
	};
	history: HistoryEntry[];
	ratings: Rating[];
	saveBehavior: SaveBehavior;
}

export interface ModelConfig {
	id: string;
	providerId: string;
	providerModelId: string;
	name: string;
	enabled: boolean;
}

export interface HistoryEntry {
	datetime: string;
	url: string;
	action: 'addToObsidian' | 'addToCraft' | 'saveFile' | 'copyToClipboard' | 'share' | 'readerMode';
	title?: string;
	vault?: string;
	path?: string;
}

export interface ConversationMessage {
	author: string;
	content: string;
	timestamp?: string;
	metadata?: Record<string, any>;
}

export interface ConversationMetadata {
	title?: string;
	description?: string;
	site: string;
	url: string;
	messageCount: number;
	startTime?: string;
	endTime?: string;
}

export interface Footnote {
	url: string;
	text: string;
}
