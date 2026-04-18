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

interface PersistedTabState {
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

const frameStatesByTab = new Map<number, Map<number, PopupState>>();
const lastSuccessfulFrameByTab = new Map<number, number>();
const popupPorts = new Set<browser.Runtime.Port>();

function isMissingTabError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return text.includes("No tab with id");
}

async function tabExists(tabId: number): Promise<boolean> {
	try {
		const tab = await browser.tabs.get(tabId);
		return typeof tab?.id === "number";
	} catch {
		return false;
	}
}

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
): Promise<PersistedTabState | null> {
	const key = getPersistedTabStateKey(tabId);
	const stored = await getTabStateStorageArea().get(key);
	return (stored[key] as PersistedTabState | undefined) ?? null;
}

async function writePersistedTabState(
	tabId: number,
	entry: FrameStateEntry | null,
): Promise<void> {
	const key = getPersistedTabStateKey(tabId);
	const storageArea = getTabStateStorageArea();

	if (entry) {
		await storageArea.set({ [key]: entry });
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
	return Boolean(states && states.size > 0);
}

function setFrameState(
	tabId: number,
	frameId: number,
	state: PopupState,
): void {
	getTabFrameStates(tabId).set(frameId, state);
	if (state.hasMedia) {
		lastSuccessfulFrameByTab.set(tabId, frameId);
	}
}

function removeFrameState(tabId: number, frameId: number): void {
	const states = frameStatesByTab.get(tabId);
	if (!states) return;
	states.delete(frameId);
	if (states.size === 0) {
		frameStatesByTab.delete(tabId);
	}
	if (lastSuccessfulFrameByTab.get(tabId) === frameId) {
		lastSuccessfulFrameByTab.delete(tabId);
	}
}

async function hydratePersistedTabState(
	tabId: number,
): Promise<FrameStateEntry | null> {
	if (hasLiveFrameState(tabId)) {
		return getBestEntry(tabId);
	}

	const persisted = await readPersistedTabState(tabId);
	if (persisted) {
		setFrameState(tabId, persisted.frameId, persisted.state);
		return persisted;
	}

	return null;
}

async function clearTabState(tabId: number): Promise<void> {
	frameStatesByTab.delete(tabId);
	lastSuccessfulFrameByTab.delete(tabId);
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

function compareFrameEntries(
	tabId: number,
	left: FrameStateEntry,
	right: FrameStateEntry,
): number {
	const lastSuccessfulFrameId = lastSuccessfulFrameByTab.get(tabId);
	if (
		lastSuccessfulFrameId === left.frameId ||
		lastSuccessfulFrameId === right.frameId
	) {
		if (
			lastSuccessfulFrameId === left.frameId &&
			lastSuccessfulFrameId !== right.frameId
		) {
			return -1;
		}
		if (
			lastSuccessfulFrameId === right.frameId &&
			lastSuccessfulFrameId !== left.frameId
		) {
			return 1;
		}
	}

	if (left.state.hasMedia !== right.state.hasMedia) {
		return left.state.hasMedia ? -1 : 1;
	}

	if (left.state.siteDisabled !== right.state.siteDisabled) {
		return left.state.siteDisabled ? 1 : -1;
	}

	if (left.state.activeKind !== right.state.activeKind) {
		if (left.state.activeKind === "video") return -1;
		if (right.state.activeKind === "video") return 1;
		if (left.state.activeKind === "audio") return -1;
		if (right.state.activeKind === "audio") return 1;
	}

	const leftHasSpeed = typeof left.state.currentSpeed === "number";
	const rightHasSpeed = typeof right.state.currentSpeed === "number";
	if (leftHasSpeed !== rightHasSpeed) {
		return leftHasSpeed ? -1 : 1;
	}

	if (left.state.mediaCount !== right.state.mediaCount) {
		return right.state.mediaCount - left.state.mediaCount;
	}

	return left.frameId - right.frameId;
}

function getOrderedFrameEntries(tabId: number): FrameStateEntry[] {
	const entries = getFrameEntries(tabId);
	entries.sort((left, right) => compareFrameEntries(tabId, left, right));
	return entries;
}

function getBestEntry(tabId: number): FrameStateEntry | null {
	return getOrderedFrameEntries(tabId)[0] ?? null;
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
	const entry = getBestEntry(tabId);
	const state = entry?.state ?? null;
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

	await writePersistedTabState(tabId, entry);
	notifyPopupPorts(tabId, state);
}

async function sendContentMessage(
	tabId: number,
	message: ContentRequestMessage,
	frameId: number,
): Promise<PopupState | null> {
	if (!(await tabExists(tabId))) {
		await clearTabState(tabId);
		return null;
	}

	try {
		const response = await browser.tabs.sendMessage(tabId, message, {
			frameId,
		});
		return (response as PopupState | null | undefined) ?? null;
	} catch (error) {
		removeFrameState(tabId, frameId);
		if (isMissingTabError(error)) {
			await clearTabState(tabId);
		}
		return null;
	}
}

function getPreferredFrameIds(tabId: number): number[] {
	const frameIds = getOrderedFrameEntries(tabId).map((entry) => entry.frameId);
	frameIds.push(0);
	return Array.from(new Set(frameIds));
}

async function refreshPreferredFrameStates(
	tabId: number,
): Promise<FrameStateEntry | null> {
	const frameIds = getPreferredFrameIds(tabId);

	for (const frameId of frameIds) {
		const state = await sendContentMessage(
			tabId,
			{ type: MESSAGE_TYPES.getState },
			frameId,
		);
		if (!state) continue;

		setFrameState(tabId, frameId, state);
	}

	await applyBadge(tabId);
	return getBestEntry(tabId);
}

async function getTabState(tabId: number): Promise<TabStateResponse> {
	if (!(await tabExists(tabId))) {
		await clearTabState(tabId);
		return { state: null };
	}

	await hydratePersistedTabState(tabId);
	const entry = await refreshPreferredFrameStates(tabId);
	return { state: entry?.state ?? null };
}

async function relayToBestFrame(
	tabId: number,
	message: ContentRequestMessage,
): Promise<TabStateResponse> {
	if (!(await tabExists(tabId))) {
		await clearTabState(tabId);
		return { state: null };
	}

	await hydratePersistedTabState(tabId);
	const frameIds = getPreferredFrameIds(tabId);

	for (const frameId of frameIds) {
		const response = await sendContentMessage(tabId, message, frameId);
		if (!response) continue;

		setFrameState(tabId, frameId, response);
		if (!response.hasMedia) {
			continue;
		}

		await applyBadge(tabId);
		return { state: response };
	}

	await applyBadge(tabId);
	return { state: getBestEntry(tabId)?.state ?? null };
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
			return relayToBestFrame(applyTabActionMessage.payload.tabId, {
				type: MESSAGE_TYPES.applyAction,
				payload: { action: applyTabActionMessage.payload.action },
			} satisfies ApplyActionMessage);
		}

		const applyTabExactSpeedMessage = message as ApplyTabExactSpeedMessage;
		if (applyTabExactSpeedMessage?.type === MESSAGE_TYPES.applyTabExactSpeed) {
			return relayToBestFrame(applyTabExactSpeedMessage.payload.tabId, {
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
