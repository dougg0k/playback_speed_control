export type ShortcutAction = "increase" | "decrease" | "reset" | "preferred";

export interface ShortcutConfig {
	increase: string;
	decrease: string;
	reset: string;
	preferred: string;
}

export interface AppSettings {
	enabled: boolean;
	preferredSpeed: number;
	speedStep: number;
	rememberLastSpeed: boolean;
	autoRestoreSpeedOnNewMedia: boolean;
	workOnAudio: boolean;
	toastEnabled: boolean;
	disabledSites: string[];
	shortcuts: ShortcutConfig;
}

export interface SavedSpeedEntry {
	value: number;
	updatedAt: number;
	restorable?: true;
}

export interface PersistedPlaybackState {
	hostLastSpeed: Record<string, SavedSpeedEntry>;
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
	increase: "d",
	decrease: "s",
	reset: "Alt+Shift+0",
	preferred: "Alt+Shift+9",
};

export const DEFAULT_SETTINGS: AppSettings = {
	enabled: true,
	preferredSpeed: 1,
	speedStep: 0.1,
	rememberLastSpeed: true,
	autoRestoreSpeedOnNewMedia: true,
	workOnAudio: false,
	toastEnabled: true,
	disabledSites: [],
	shortcuts: DEFAULT_SHORTCUTS,
};

export const DEFAULT_PLAYBACK_STATE: PersistedPlaybackState = {
	hostLastSpeed: {},
};
