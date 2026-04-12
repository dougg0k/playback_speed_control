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

const PERSISTED_TAB_STATE_PREFIX = "psc:tab-state:";
const PERSISTED_FRAME_ID = -1;

const frameStatesByTab = new Map<number, Map<number, PopupState>>();
const popupPorts = new Set<browser.Runtime.Port>();

function getPersistedTabStateKey(tabId: number): string {
	return `${PERSISTED_TAB_STATE_PREFIX}${tabId}`;
}

async function readPersistedTabState(
	tabId: number,
): Promise<PopupState | null> {
	const key = getPersistedTabStateKey(tabId);
	const stored = await browser.storage.session.get(key);
	return (stored[key] as PopupState | undefined) ?? null;
}

async function writePersistedTabState(
	tabId: number,
	state: PopupState | null,
): Promise<void> {
	const key = getPersistedTabStateKey(tabId);
	if (state) {
		await browser.storage.session.set({ [key]: state });
	} else {
		await browser.storage.session.remove(key);
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

function notifyPopupPorts(tabId: number, state: PopupState | null): void {
	const message: TabStateChangedMessage = {
		type: "PSC_TAB_STATE_CHANGED",
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
	const badgeText =
		state?.hasMedia && !state.siteDisabled
			? formatBadgeSpeed(state.currentSpeed)
			: "";

	await browser.action.setBadgeBackgroundColor({
		tabId,
		color: state?.siteDisabled ? "#475569" : "#F59E0B",
	});
	await browser.action.setBadgeText({ tabId, text: badgeText });
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
	const state = await sendContentMessage(tabId, { type: "PSC_GET_STATE" }, 0);
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
	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== "psc-popup") return;

		popupPorts.add(port);
		port.onDisconnect.addListener(() => {
			popupPorts.delete(port);
		});
	});

	browser.runtime.onMessage.addListener((message: unknown, sender) => {
		const snapshotMessage = message as StateSnapshotMessage;
		if (snapshotMessage?.type === "PSC_STATE_SNAPSHOT") {
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
		if (getTabStateMessage?.type === "PSC_GET_TAB_STATE") {
			return getTabState(getTabStateMessage.payload.tabId);
		}

		const applyTabActionMessage = message as ApplyTabActionMessage;
		if (applyTabActionMessage?.type === "PSC_APPLY_TAB_ACTION") {
			return relayToTopFrame(applyTabActionMessage.payload.tabId, {
				type: "PSC_APPLY_ACTION",
				payload: { action: applyTabActionMessage.payload.action },
			} satisfies ApplyActionMessage);
		}

		const applyTabExactSpeedMessage = message as ApplyTabExactSpeedMessage;
		if (applyTabExactSpeedMessage?.type === "PSC_APPLY_TAB_EXACT_SPEED") {
			return relayToTopFrame(applyTabExactSpeedMessage.payload.tabId, {
				type: "PSC_APPLY_EXACT_SPEED",
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
				await browser.action.setBadgeText({ tabId, text: "" });
				notifyPopupPorts(tabId, null);
			})();
		}
	});
});
