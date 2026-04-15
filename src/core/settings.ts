import { STORAGE_KEYS } from "@/constants/extension";
import {
	DEFAULT_PLAYBACK_STATE,
	DEFAULT_SETTINGS,
	type AppSettings,
	type PersistedPlaybackState,
	type SaveScope,
	type ShortcutConfig,
} from "@/types/settings";
import { clampSpeed } from "@/utils/numbers";
import { normalizeRules } from "./siteRules";
import { browser } from "wxt/browser";

function sanitizeShortcuts(
	value: Partial<ShortcutConfig> | undefined,
): ShortcutConfig {
	return {
		increase: value?.increase?.trim() || DEFAULT_SETTINGS.shortcuts.increase,
		decrease: value?.decrease?.trim() || DEFAULT_SETTINGS.shortcuts.decrease,
		reset: value?.reset?.trim() || DEFAULT_SETTINGS.shortcuts.reset,
		preferred: value?.preferred?.trim() || DEFAULT_SETTINGS.shortcuts.preferred,
	};
}

function sanitizeSaveScope(value: unknown): SaveScope {
	return value === "global" ? "global" : "site";
}

export function sanitizeSettings(
	value: Partial<AppSettings> | undefined,
): AppSettings {
	return {
		enabled: value?.enabled ?? DEFAULT_SETTINGS.enabled,
		preferredSpeed: clampSpeed(
			value?.preferredSpeed ?? DEFAULT_SETTINGS.preferredSpeed,
		),
		speedStep: Math.min(
			4,
			Math.max(
				0.05,
				Number((value?.speedStep ?? DEFAULT_SETTINGS.speedStep).toFixed(2)),
			),
		),
		rememberLastSpeed:
			value?.rememberLastSpeed ?? DEFAULT_SETTINGS.rememberLastSpeed,
		saveScope: sanitizeSaveScope(value?.saveScope),
		forceSavedSpeedOnLoad:
			value?.forceSavedSpeedOnLoad ?? DEFAULT_SETTINGS.forceSavedSpeedOnLoad,
		workOnAudio: value?.workOnAudio ?? DEFAULT_SETTINGS.workOnAudio,
		toastEnabled: value?.toastEnabled ?? DEFAULT_SETTINGS.toastEnabled,
		disabledSites: normalizeRules(
			value?.disabledSites ?? DEFAULT_SETTINGS.disabledSites,
		),
		shortcuts: sanitizeShortcuts(value?.shortcuts),
	};
}

function sanitizePlaybackState(
	value: Partial<PersistedPlaybackState> | undefined,
): PersistedPlaybackState {
	const siteLastSpeedEntries = Object.entries(
		value?.siteLastSpeed ?? {},
	).filter(([siteKey, speed]) => Boolean(siteKey) && typeof speed === "number");

	return {
		globalLastSpeed:
			typeof value?.globalLastSpeed === "number"
				? clampSpeed(value.globalLastSpeed)
				: DEFAULT_PLAYBACK_STATE.globalLastSpeed,
		siteLastSpeed: Object.fromEntries(
			siteLastSpeedEntries.map(([siteKey, speed]) => [
				siteKey,
				clampSpeed(speed),
			]),
		),
	};
}

export async function getSettings(): Promise<AppSettings> {
	const stored = await browser.storage.local.get(STORAGE_KEYS.settings);
	return sanitizeSettings(
		stored[STORAGE_KEYS.settings] as Partial<AppSettings> | undefined,
	);
}

export async function updateSettings(
	partial: Partial<AppSettings>,
): Promise<AppSettings> {
	const current = await getSettings();
	const next = sanitizeSettings({ ...current, ...partial });
	await browser.storage.local.set({ [STORAGE_KEYS.settings]: next });
	return next;
}

export async function getPlaybackState(): Promise<PersistedPlaybackState> {
	const stored = await browser.storage.local.get(STORAGE_KEYS.playbackState);
	return sanitizePlaybackState(
		stored[STORAGE_KEYS.playbackState] as
			| Partial<PersistedPlaybackState>
			| undefined,
	);
}

export async function getLastSavedSpeed(
	scope: SaveScope,
	siteKey: string,
): Promise<number | null> {
	const state = await getPlaybackState();
	if (scope === "global") return state.globalLastSpeed;
	return state.siteLastSpeed[siteKey] ?? null;
}

export async function setLastSavedSpeed(
	scope: SaveScope,
	siteKey: string,
	speed: number,
): Promise<void> {
	const current = await getPlaybackState();
	const next = { ...current };

	if (scope === "global") {
		next.globalLastSpeed = clampSpeed(speed);
	} else if (siteKey) {
		next.siteLastSpeed = {
			...current.siteLastSpeed,
			[siteKey]: clampSpeed(speed),
		};
	}

	await browser.storage.local.set({ [STORAGE_KEYS.playbackState]: next });
}

export function listenForSettingsChanges(
	callback: (settings: AppSettings) => void,
): () => void {
	const handler = (
		changes: Record<string, browser.Storage.StorageChange>,
		areaName: string,
	) => {
		if (areaName !== "local" || !(STORAGE_KEYS.settings in changes)) return;
		callback(
			sanitizeSettings(
				changes[STORAGE_KEYS.settings].newValue as Partial<AppSettings>,
			),
		);
	};

	browser.storage.onChanged.addListener(handler);
	return () => browser.storage.onChanged.removeListener(handler);
}
