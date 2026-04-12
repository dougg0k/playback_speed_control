import type { PopupState, StateSnapshotMessage } from "@/types/messages";
import { formatBadgeSpeed } from "@/utils/numbers";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

const tabState = new Map<number, PopupState>();

async function applyBadge(tabId: number): Promise<void> {
	const state = tabState.get(tabId);
	const badgeText =
		state?.hasMedia && !state.siteDisabled
			? formatBadgeSpeed(state.currentSpeed)
			: "";

	await browser.action.setBadgeBackgroundColor({
		tabId,
		color: state?.siteDisabled ? "#475569" : "#F59E0B",
	});
	await browser.action.setBadgeText({ tabId, text: badgeText });
}

export default defineBackground(() => {
	browser.runtime.onMessage.addListener((message: unknown, sender) => {
		const runtimeMessage = message as StateSnapshotMessage;
		if (runtimeMessage?.type !== "PSC_STATE_SNAPSHOT") return undefined;

		const tabId = sender.tab?.id;
		if (typeof tabId !== "number") return undefined;

		tabState.set(tabId, runtimeMessage.payload);
		void applyBadge(tabId);
		return undefined;
	});

	browser.tabs.onActivated.addListener(({ tabId }) => {
		void applyBadge(tabId);
	});

	browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.status === "loading") {
			tabState.delete(tabId);
			void browser.action.setBadgeText({ tabId, text: "" });
		}
	});

	browser.tabs.onRemoved.addListener((tabId) => {
		tabState.delete(tabId);
	});
});
