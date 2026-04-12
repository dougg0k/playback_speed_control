import {
	getSettings,
	getLastSavedSpeed,
	listenForSettingsChanges,
	setLastSavedSpeed,
} from "@/core/settings";
import { isHostnameDisabled } from "@/core/siteRules";
import { matchShortcutAction, isEditableTarget } from "@/core/shortcuts";
import { ToastController } from "@/core/toast";
import { MediaRegistry } from "@/core/mediaRegistry";
import type {
	ApplyActionMessage,
	ApplyExactSpeedMessage,
	GetStateMessage,
	RuntimeMessage,
} from "@/types/messages";
import type { AppSettings } from "@/types/settings";
import { formatSpeed } from "@/utils/numbers";
import { getCurrentHostname } from "@/utils/urls";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
	matches: ["<all_urls>"],
	allFrames: true,
	runAt: "document_end",
	main() {
		const hostname = getCurrentHostname();
		const toast = new ToastController();
		let settings: AppSettings;

		const resolveSettings = (nextSettings: AppSettings): AppSettings => ({
			...nextSettings,
			enabled:
				nextSettings.enabled &&
				!isHostnameDisabled(hostname, nextSettings.disabledSites),
		});

		const registry = new MediaRegistry({
			getSettings: () => settings,
			getDesiredSpeed: () => desiredSpeed,
			hostname,
			onSpeedPersist: async (speed) => {
				if (!settings.rememberLastSpeed) return;
				await setLastSavedSpeed(settings.saveScope, hostname, speed);
			},
			onStateChanged: (state) => {
				void browser.runtime.sendMessage({
					type: "PSC_STATE_SNAPSHOT",
					payload: state,
				} satisfies RuntimeMessage);
			},
		});

		let desiredSpeed = 1;

		const refreshDesiredSpeed = async () => {
			const remembered = settings.rememberLastSpeed
				? await getLastSavedSpeed(settings.saveScope, hostname)
				: null;
			desiredSpeed = remembered ?? settings.preferredSpeed;
			registry.updateSettings();
		};

		const handleShortcutAction = async (
			action: "increase" | "decrease" | "reset" | "preferred",
		) => {
			const nextSpeed = await registry.applyAction(action);
			if (nextSpeed !== null && settings.toastEnabled) {
				toast.show(action === "reset" ? "Reset to 1x" : formatSpeed(nextSpeed));
			}
		};

		const handleKeydown = (event: KeyboardEvent) => {
			if (!settings.enabled || isEditableTarget(event.target)) return;
			const action = matchShortcutAction(event, settings.shortcuts);
			if (!action) return;
			event.preventDefault();
			void handleShortcutAction(action);
		};

		const handleRuntimeMessage = async (message: unknown) => {
			const runtimeMessage = message as RuntimeMessage;

			if ((runtimeMessage as GetStateMessage)?.type === "PSC_GET_STATE") {
				return registry.getState();
			}

			if ((runtimeMessage as ApplyActionMessage)?.type === "PSC_APPLY_ACTION") {
				const nextSpeed = await registry.applyAction(
					(runtimeMessage as ApplyActionMessage).payload.action,
				);
				if (nextSpeed !== null && settings.toastEnabled) {
					toast.show(formatSpeed(nextSpeed));
				}
				return registry.getState();
			}

			if (
				(runtimeMessage as ApplyExactSpeedMessage)?.type ===
				"PSC_APPLY_EXACT_SPEED"
			) {
				const nextSpeed = await registry.applyExactSpeed(
					(runtimeMessage as ApplyExactSpeedMessage).payload.speed,
				);
				if (nextSpeed !== null && settings.toastEnabled) {
					toast.show(formatSpeed(nextSpeed));
				}
				return registry.getState();
			}

			return undefined;
		};

		const initialize = async () => {
			settings = resolveSettings(await getSettings());
			await refreshDesiredSpeed();
			registry.start();
			window.addEventListener("keydown", handleKeydown, true);
			browser.runtime.onMessage.addListener(handleRuntimeMessage);
		};

		const stopListeningToStorage = listenForSettingsChanges(
			async (nextSettings) => {
				settings = resolveSettings(nextSettings);
				await refreshDesiredSpeed();
			},
		);

		void initialize();

		return () => {
			stopListeningToStorage();
			registry.stop();
			window.removeEventListener("keydown", handleKeydown, true);
			browser.runtime.onMessage.removeListener(handleRuntimeMessage);
		};
	},
});
