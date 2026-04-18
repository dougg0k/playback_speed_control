import { STORAGE_KEYS } from "@/constants/extension";
import {
	DEFAULT_SETTINGS,
	type AppSettings,
	type PersistedPlaybackState,
	type SaveScope,
	type SavedSpeedEntry,
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

function sanitizeSavedSpeedEntry(value: unknown): SavedSpeedEntry | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as Partial<SavedSpeedEntry>;
	if (
		typeof candidate.value !== "number" ||
		!Number.isFinite(candidate.value)
	) {
		return null;
	}

	return {
		value: clampSpeed(candidate.value),
		updatedAt:
			typeof candidate.updatedAt === "number" &&
			Number.isFinite(candidate.updatedAt)
				? candidate.updatedAt
				: Date.now(),
		restorable: candidate.restorable === true ? true : undefined,
	};
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
	const siteLastSpeed: Record<string, SavedSpeedEntry> = {};

	for (const [siteKey, entry] of Object.entries(value?.siteLastSpeed ?? {})) {
		const sanitizedEntry = sanitizeSavedSpeedEntry(entry);
		if (!siteKey || !sanitizedEntry) {
			continue;
		}
		siteLastSpeed[siteKey] = sanitizedEntry;
	}

	return {
		globalLastSpeed: sanitizeSavedSpeedEntry(value?.globalLastSpeed),
		siteLastSpeed,
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

async function getSavedSpeedEntry(
	scope: SaveScope,
	siteKey: string,
): Promise<SavedSpeedEntry | null> {
	const state = await getPlaybackState();
	if (scope === "global") {
		return state.globalLastSpeed;
	}

	return state.siteLastSpeed[siteKey] ?? null;
}

export async function getRestorableSavedSpeed(
	scope: SaveScope,
	siteKey: string,
): Promise<number | null> {
	const entry = await getSavedSpeedEntry(scope, siteKey);
	if (!entry || entry.restorable !== true) {
		return null;
	}

	return entry.value;
}

export async function setLastSavedSpeed(
	scope: SaveScope,
	siteKey: string,
	speed: number,
): Promise<void> {
	const current = await getPlaybackState();
	const nextEntry: SavedSpeedEntry = {
		value: clampSpeed(speed),
		updatedAt: Date.now(),
		restorable: true,
	};

	if (scope === "global") {
		await browser.storage.local.set({
			[STORAGE_KEYS.playbackState]: {
				...current,
				globalLastSpeed: nextEntry,
			},
		});
		return;
	}

	if (!siteKey) {
		return;
	}

	await browser.storage.local.set({
		[STORAGE_KEYS.playbackState]: {
			...current,
			siteLastSpeed: {
				...current.siteLastSpeed,
				[siteKey]: nextEntry,
			},
		},
	});
}

export function listenForSettingsChanges(
	callback: (settings: AppSettings) => void,
): () => void {
	const handler = (
		changes: Record<string, browser.Storage.StorageChange>,
		areaName: string,
	) => {
		if (areaName !== "local" || !(STORAGE_KEYS.settings in changes)) {
			return;
		}

		callback(
			sanitizeSettings(
				changes[STORAGE_KEYS.settings].newValue as Partial<AppSettings>,
			),
		);
	};

	browser.storage.onChanged.addListener(handler);
	return () => browser.storage.onChanged.removeListener(handler);
}
