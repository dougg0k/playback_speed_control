import {
	BADGE_COLORS,
	BADGE_VALIDATION,
	MESSAGE_TYPES,
	PORT_NAMES,
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

const frameStatesByTab = new Map<number, Map<number, PopupState>>();
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

function getTabFrameStates(tabId: number): Map<number, PopupState> {
	let states = frameStatesByTab.get(tabId);
	if (!states) {
		states = new Map<number, PopupState>();
		frameStatesByTab.set(tabId, states);
	}
	return states;
}

function setFrameState(
	tabId: number,
	frameId: number,
	state: PopupState,
): void {
	getTabFrameStates(tabId).set(frameId, state);
}

function removeFrameState(tabId: number, frameId: number): void {
	const states = frameStatesByTab.get(tabId);
	if (!states) {
		return;
	}

	states.delete(frameId);
	if (states.size === 0) {
		frameStatesByTab.delete(tabId);
	}
}

function clearTabState(tabId: number): void {
	frameStatesByTab.delete(tabId);
}

function shouldReplaceBestState(
	next: FrameStateEntry,
	current: FrameStateEntry,
): boolean {
	if (next.state.hasMedia !== current.state.hasMedia) {
		return next.state.hasMedia;
	}

	if (next.state.siteDisabled !== current.state.siteDisabled) {
		return !next.state.siteDisabled;
	}

	if (next.state.activeKind !== current.state.activeKind) {
		if (next.state.activeKind === "video") return true;
		if (current.state.activeKind === "video") return false;
		if (next.state.activeKind === "audio") return true;
		if (current.state.activeKind === "audio") return false;
	}

	const nextHasSpeed = typeof next.state.currentSpeed === "number";
	const currentHasSpeed = typeof current.state.currentSpeed === "number";
	if (nextHasSpeed !== currentHasSpeed) {
		return nextHasSpeed;
	}

	if (next.state.mediaCount !== current.state.mediaCount) {
		return next.state.mediaCount > current.state.mediaCount;
	}

	return next.frameId < current.frameId;
}

function getBestEntry(tabId: number): FrameStateEntry | null {
	const states = frameStatesByTab.get(tabId);
	if (!states) {
		return null;
	}

	let best: FrameStateEntry | null = null;
	for (const [frameId, state] of states.entries()) {
		const entry = { frameId, state };
		if (!best || shouldReplaceBestState(entry, best)) {
			best = entry;
		}
	}

	return best;
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

	for (const port of popupPorts) {
		try {
			port.postMessage(message);
		} catch {
			popupPorts.delete(port);
		}
	}
}

async function applyBadge(tabId: number): Promise<void> {
	const state = getBestEntry(tabId)?.state ?? null;
	const stableState =
		isBadgeStateStable(state) && !state.siteDisabled ? state : null;
	const badgeApi = getBadgeApi();
	if (!badgeApi) {
		notifyPopupPorts(tabId, state);
		return;
	}

	await Promise.resolve(
		badgeApi.setBadgeBackgroundColor({
			tabId,
			color: state?.siteDisabled ? BADGE_COLORS.disabled : BADGE_COLORS.active,
		}),
	);
	await Promise.resolve(
		badgeApi.setBadgeText({
			tabId,
			text: stableState ? formatBadgeSpeed(stableState.currentSpeed) : "",
		}),
	);
	notifyPopupPorts(tabId, state);
}

async function sendContentMessage(
	tabId: number,
	message: ContentRequestMessage,
	frameId: number,
): Promise<PopupState | null> {
	if (!(await tabExists(tabId))) {
		clearTabState(tabId);
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
			clearTabState(tabId);
		}
		return null;
	}
}

function getKnownFrameIds(tabId: number): number[] {
	const frameIds: number[] = [0];
	const states = frameStatesByTab.get(tabId);
	if (!states) {
		return frameIds;
	}

	for (const frameId of states.keys()) {
		if (!frameIds.includes(frameId)) {
			frameIds.push(frameId);
		}
	}

	return frameIds;
}

async function refreshKnownFrameStates(tabId: number): Promise<void> {
	for (const frameId of getKnownFrameIds(tabId)) {
		const state = await sendContentMessage(
			tabId,
			{ type: MESSAGE_TYPES.getState },
			frameId,
		);
		if (!state) {
			continue;
		}

		if (!state.hasMedia && frameId !== 0) {
			removeFrameState(tabId, frameId);
			continue;
		}

		setFrameState(tabId, frameId, state);
	}
}

function getRelayFrameOrder(tabId: number): number[] {
	const order: number[] = [];
	const bestFrameId = getBestEntry(tabId)?.frameId;
	if (typeof bestFrameId === "number") {
		order.push(bestFrameId);
	}

	for (const frameId of getKnownFrameIds(tabId)) {
		if (!order.includes(frameId)) {
			order.push(frameId);
		}
	}

	return order;
}

async function getTabState(tabId: number): Promise<TabStateResponse> {
	if (!(await tabExists(tabId))) {
		clearTabState(tabId);
		return { state: null };
	}

	await refreshKnownFrameStates(tabId);
	await applyBadge(tabId);
	return { state: getBestEntry(tabId)?.state ?? null };
}

async function relayToBestFrame(
	tabId: number,
	message: ContentRequestMessage,
): Promise<TabStateResponse> {
	if (!(await tabExists(tabId))) {
		clearTabState(tabId);
		return { state: null };
	}

	await refreshKnownFrameStates(tabId);

	for (const frameId of getRelayFrameOrder(tabId)) {
		const response = await sendContentMessage(tabId, message, frameId);
		if (!response) {
			continue;
		}

		if (!response.hasMedia && frameId !== 0) {
			removeFrameState(tabId, frameId);
			continue;
		}

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
	popupPorts.clear();

	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== PORT_NAMES.popup) {
			return;
		}

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
			if (typeof tabId !== "number") {
				return undefined;
			}

			void (async () => {
				if (!snapshotMessage.payload.hasMedia && frameId !== 0) {
					removeFrameState(tabId, frameId);
				} else {
					setFrameState(tabId, frameId, snapshotMessage.payload);
				}

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
		clearTabState(tabId);
	});

	browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.status !== "loading") {
			return;
		}

		void (async () => {
			clearTabState(tabId);
			const badgeApi = getBadgeApi();
			if (badgeApi) {
				await Promise.resolve(badgeApi.setBadgeText({ tabId, text: "" }));
			}
			notifyPopupPorts(tabId, null);
		})();
	});
});
