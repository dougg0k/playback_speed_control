import {
	BADGE_COLORS,
	BADGE_VALIDATION,
	MESSAGE_TYPES,
	PORT_NAMES,
	STORAGE_KEYS,
} from "@/constants/extension";
import type {
	ApplyActionMessage,
	ApplyExactSpeedMessage,
	ApplyTabActionMessage,
	ApplyTabExactSpeedMessage,
	ContentRequestMessage,
	GetTabStateMessage,
	PopupState,
	StateSnapshotMessage,
	TabStateChangedMessage,
	TabStateResponse,
} from "@/types/messages";
import { formatBadgeSpeed } from "@/utils/numbers";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

interface FrameStateEntry {
	frameId: number;
	state: PopupState;
}

type BadgeApi = {
	setBadgeBackgroundColor(details: {
		tabId?: number;
		color: string | number[];
	}): Promise<unknown> | void;
	setBadgeText(details: {
		tabId?: number;
		text: string | null;
	}): Promise<unknown> | void;
};

type StorageAreaLike = {
	get(
		keys?: string | string[] | Record<string, unknown> | null,
	): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
};

const PERSISTED_FRAME_ID = -1;
const frameStatesByTab = new Map<number, Map<number, PopupState>>();
const popupPorts = new Set<browser.Runtime.Port>();

function getBadgeApi(): BadgeApi | null {
	const maybeBrowser = browser as typeof browser & {
		browserAction?: BadgeApi;
		browser_action?: BadgeApi;
	};

	return (
		maybeBrowser.action ??
		maybeBrowser.browserAction ??
		maybeBrowser.browser_action ??
		null
	);
}

function getPersistedTabStateKey(tabId: number): string {
	return `${STORAGE_KEYS.tabStatePrefix}${tabId}`;
}

function getTabStateStorageArea(): StorageAreaLike {
	const maybeStorage = browser.storage as typeof browser.storage & {
		session?: StorageAreaLike;
	};

	return maybeStorage.session ?? browser.storage.local;
}

async function clearLocalTabStateFallbackCache(): Promise<void> {
	if (
		(browser.storage as typeof browser.storage & { session?: StorageAreaLike })
			.session
	) {
		return;
	}

	const storageArea = getTabStateStorageArea();
	const stored = await storageArea.get(null);
	const keys = Object.keys(stored).filter((key) =>
		key.startsWith(STORAGE_KEYS.tabStatePrefix),
	);
	if (keys.length > 0) {
		await storageArea.remove(keys);
	}
}

async function readPersistedTabState(
	tabId: number,
): Promise<PopupState | null> {
	const key = getPersistedTabStateKey(tabId);
	const stored = await getTabStateStorageArea().get(key);
	return (stored[key] as PopupState | undefined) ?? null;
}

async function writePersistedTabState(
	tabId: number,
	state: PopupState | null,
): Promise<void> {
	const key = getPersistedTabStateKey(tabId);
	const storageArea = getTabStateStorageArea();

	if (state) {
		await storageArea.set({ [key]: state });
	} else {
		await storageArea.remove(key);
	}
}

function getTabFrameStates(tabId: number): Map<number, PopupState> {
	let states = frameStatesByTab.get(tabId);
	if (!states) {
		states = new Map<number, PopupState>();
		frameStatesByTab.set(tabId, states);
	}
	return states;
}

function hasLiveFrameState(tabId: number): boolean {
	const states = frameStatesByTab.get(tabId);
	if (!states) return false;
	return Array.from(states.keys()).some((frameId) => frameId >= 0);
}

function setFrameState(
	tabId: number,
	frameId: number,
	state: PopupState,
): void {
	const states = getTabFrameStates(tabId);
	if (frameId >= 0) {
		states.delete(PERSISTED_FRAME_ID);
	}
	states.set(frameId, state);
}

async function hydratePersistedTabState(
	tabId: number,
): Promise<PopupState | null> {
	if (hasLiveFrameState(tabId)) {
		return getBestState(tabId);
	}

	const persisted = await readPersistedTabState(tabId);
	if (persisted) {
		getTabFrameStates(tabId).set(PERSISTED_FRAME_ID, persisted);
	}
	return persisted;
}

async function clearTabState(tabId: number): Promise<void> {
	frameStatesByTab.delete(tabId);
	await writePersistedTabState(tabId, null);
}

function getFrameEntries(tabId: number): FrameStateEntry[] {
	const states = frameStatesByTab.get(tabId);
	if (!states) return [];
	return Array.from(states.entries()).map(([frameId, state]) => ({
		frameId,
		state,
	}));
}

function getStateScore(entry: FrameStateEntry): number {
	let score = 0;
	if (entry.state.hasMedia) score += 100;
	if (entry.state.currentSpeed !== null) score += 10;
	if (entry.state.activeKind === "video") score += 5;
	if (entry.frameId === 0) score += 1;
	return score;
}

function getBestState(tabId: number): PopupState | null {
	const entries = getFrameEntries(tabId);
	if (entries.length === 0) return null;

	entries.sort((left, right) => getStateScore(right) - getStateScore(left));
	return entries[0]?.state ?? null;
}

function isBadgeStateStable(state: PopupState | null): state is PopupState {
	return Boolean(
		state &&
			state.hasMedia &&
			state.activeKind &&
			state.hostname &&
			typeof state.currentSpeed === "number" &&
			Number.isFinite(state.currentSpeed) &&
			state.currentSpeed >= BADGE_VALIDATION.minStableSpeed,
	);
}

function notifyPopupPorts(tabId: number, state: PopupState | null): void {
	const message: TabStateChangedMessage = {
		type: MESSAGE_TYPES.tabStateChanged,
		payload: { tabId, state },
	};

	for (const port of Array.from(popupPorts)) {
		try {
			port.postMessage(message);
		} catch {
			popupPorts.delete(port);
		}
	}
}

async function applyBadge(tabId: number): Promise<void> {
	const state = getBestState(tabId);
	const preserveExistingBadge = Boolean(
		state &&
			typeof state.currentSpeed === "number" &&
			Number.isFinite(state.currentSpeed) &&
			state.currentSpeed > 0 &&
			state.currentSpeed < BADGE_VALIDATION.minStableSpeed,
	);

	if (!preserveExistingBadge) {
		const stableBadgeState =
			isBadgeStateStable(state) && !state.siteDisabled ? state : null;
		const badgeText = stableBadgeState
			? formatBadgeSpeed(stableBadgeState.currentSpeed)
			: "";
		const badgeColor = state?.siteDisabled
			? BADGE_COLORS.disabled
			: BADGE_COLORS.active;
		const badgeApi = getBadgeApi();

		if (badgeApi) {
			await Promise.resolve(
				badgeApi.setBadgeBackgroundColor({
					tabId,
					color: badgeColor,
				}),
			);
			await Promise.resolve(badgeApi.setBadgeText({ tabId, text: badgeText }));
		}
	}

	await writePersistedTabState(tabId, state);
	notifyPopupPorts(tabId, state);
}

async function sendContentMessage(
	tabId: number,
	message: ContentRequestMessage,
	frameId = 0,
): Promise<PopupState | null> {
	try {
		const response = await browser.tabs.sendMessage(tabId, message, {
			frameId,
		});
		return (response as PopupState | null | undefined) ?? null;
	} catch {
		return null;
	}
}

async function refreshTopFrameState(tabId: number): Promise<PopupState | null> {
	const state = await sendContentMessage(
		tabId,
		{ type: MESSAGE_TYPES.getState },
		0,
	);
	if (state) {
		setFrameState(tabId, 0, state);
	}
	await applyBadge(tabId);
	return getBestState(tabId);
}

async function getTabState(tabId: number): Promise<TabStateResponse> {
	await hydratePersistedTabState(tabId);
	const cachedState = getBestState(tabId);
	const freshState = await refreshTopFrameState(tabId);

	return {
		state: freshState ?? cachedState ?? null,
	};
}

async function relayToTopFrame(
	tabId: number,
	message: ContentRequestMessage,
): Promise<TabStateResponse> {
	await hydratePersistedTabState(tabId);

	const response = await sendContentMessage(tabId, message, 0);
	if (response) {
		setFrameState(tabId, 0, response);
		await applyBadge(tabId);
		return { state: response };
	}

	const cachedState = getBestState(tabId);
	return { state: cachedState };
}

export default defineBackground(() => {
	void clearLocalTabStateFallbackCache();

	popupPorts.clear();

	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== PORT_NAMES.popup) return;

		popupPorts.add(port);
		port.onDisconnect.addListener(() => {
			popupPorts.delete(port);
		});
	});

	browser.runtime.onMessage.addListener((message: unknown, sender) => {
		const snapshotMessage = message as StateSnapshotMessage;
		if (snapshotMessage?.type === MESSAGE_TYPES.stateSnapshot) {
			const tabId = sender.tab?.id;
			const frameId = sender.frameId ?? 0;
			if (typeof tabId !== "number") return undefined;

			void (async () => {
				setFrameState(tabId, frameId, snapshotMessage.payload);
				await applyBadge(tabId);
			})();
			return undefined;
		}

		const getTabStateMessage = message as GetTabStateMessage;
		if (getTabStateMessage?.type === MESSAGE_TYPES.getTabState) {
			return getTabState(getTabStateMessage.payload.tabId);
		}

		const applyTabActionMessage = message as ApplyTabActionMessage;
		if (applyTabActionMessage?.type === MESSAGE_TYPES.applyTabAction) {
			return relayToTopFrame(applyTabActionMessage.payload.tabId, {
				type: MESSAGE_TYPES.applyAction,
				payload: { action: applyTabActionMessage.payload.action },
			} satisfies ApplyActionMessage);
		}

		const applyTabExactSpeedMessage = message as ApplyTabExactSpeedMessage;
		if (applyTabExactSpeedMessage?.type === MESSAGE_TYPES.applyTabExactSpeed) {
			return relayToTopFrame(applyTabExactSpeedMessage.payload.tabId, {
				type: MESSAGE_TYPES.applyExactSpeed,
				payload: { speed: applyTabExactSpeedMessage.payload.speed },
			} satisfies ApplyExactSpeedMessage);
		}

		return undefined;
	});

	browser.tabs.onActivated.addListener(({ tabId }) => {
		void applyBadge(tabId);
	});

	browser.tabs.onRemoved.addListener((tabId) => {
		void clearTabState(tabId);
	});

	browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.status === "loading") {
			void (async () => {
				await clearTabState(tabId);
				const badgeApi = getBadgeApi();
				if (badgeApi) {
					await Promise.resolve(badgeApi.setBadgeText({ tabId, text: "" }));
				}
				notifyPopupPorts(tabId, null);
			})();
		}
	});
});
