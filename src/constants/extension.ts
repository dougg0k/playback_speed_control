import type { ShortcutAction } from "@/types/settings";

export const STORAGE_KEYS = {
	settings: "psc:settings",
	playbackState: "psc:playback-state",
	tabStatePrefix: "psc:tab-state:",
} as const;

export const PORT_NAMES = {
	popup: "psc-popup",
} as const;

export const MESSAGE_TYPES = {
	stateSnapshot: "PSC_STATE_SNAPSHOT",
	getState: "PSC_GET_STATE",
	applyAction: "PSC_APPLY_ACTION",
	applyExactSpeed: "PSC_APPLY_EXACT_SPEED",
	getTabState: "PSC_GET_TAB_STATE",
	applyTabAction: "PSC_APPLY_TAB_ACTION",
	applyTabExactSpeed: "PSC_APPLY_TAB_EXACT_SPEED",
	tabStateChanged: "PSC_TAB_STATE_CHANGED",
} as const;

export const BADGE_COLORS = {
	active: "#F59E0B",
	disabled: "#475569",
} as const;

export const BADGE_VALIDATION = {
	minStableSpeed: 0.1,
} as const;

export const POPUP_STATE_TIMEOUTS_MS = {
	directRead: 700,
	backgroundRead: 900,
	action: 800,
	retryShort: 200,
	retryMedium: 600,
	retryLong: 1200,
	retryAfterOpen: 500,
} as const;

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	increase: "Increase speed",
	decrease: "Decrease speed",
	reset: "Reset to 1x",
	preferred: "Apply preferred speed",
};

export const SHORTCUT_PLACEHOLDERS: Record<ShortcutAction, string> = {
	increase: "d",
	decrease: "s",
	reset: "Alt+Shift+0",
	preferred: "Alt+Shift+9",
};
