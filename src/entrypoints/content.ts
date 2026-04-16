import { MESSAGE_TYPES } from "@/constants/extension";
import {
	getSettings,
	getLastSavedSpeed,
	listenForSettingsChanges,
	setLastSavedSpeed,
} from "@/core/settings";
import { isHostnameDisabled } from "@/core/siteRules";
import { isEditableTarget, matchShortcutAction } from "@/core/shortcuts";
import { ToastController } from "@/core/toast";
import { MediaRegistry } from "@/core/mediaRegistry";
import type {
	ApplyActionMessage,
	ApplyExactSpeedMessage,
	GetStateMessage,
	RuntimeMessage,
} from "@/types/messages";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
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

		const resolveSettings = (nextSettings: AppSettings): AppSettings => ({
			...nextSettings,
			enabled:
				nextSettings.enabled &&
				!isHostnameDisabled(hostname, nextSettings.disabledSites),
		});

		let settings: AppSettings = resolveSettings(DEFAULT_SETTINGS);
		let desiredSpeed = settings.preferredSpeed;

		const registry = new MediaRegistry({
			getSettings: () => settings,
			getDesiredSpeed: () => desiredSpeed,
			hostname,
			onSpeedPersist: async (speed) => {
				desiredSpeed = speed;
				if (!settings.rememberLastSpeed) return;
				await setLastSavedSpeed(settings.saveScope, hostname, speed);
			},
			onStateChanged: (state) => {
				void browser.runtime.sendMessage({
					type: MESSAGE_TYPES.stateSnapshot,
					payload: state,
				} satisfies RuntimeMessage);
			},
		});

		const refreshDesiredSpeed = async () => {
			if (!settings.enabled) {
				desiredSpeed = 1;
				registry.updateSettings();
				return;
			}

			const remembered = settings.rememberLastSpeed
				? await getLastSavedSpeed(settings.saveScope, hostname)
				: null;
			desiredSpeed = remembered ?? settings.preferredSpeed;
			registry.updateSettings();
		};

		const emitCurrentState = () => {
			registry.updateSettings();
		};

		const showActionToast = (
			action: "increase" | "decrease" | "reset" | "preferred",
			speed: number,
		) => {
			if (!settings.toastEnabled) return;
			toast.show(action === "reset" ? "Reset to 1x" : formatSpeed(speed));
		};

		const handleShortcutAction = async (
			action: "increase" | "decrease" | "reset" | "preferred",
		) => {
			const nextSpeed = await registry.applyAction(action);
			if (nextSpeed !== null) {
				showActionToast(action, nextSpeed);
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

			if (
				(runtimeMessage as GetStateMessage)?.type === MESSAGE_TYPES.getState
			) {
				return registry.getState();
			}

			if (
				(runtimeMessage as ApplyActionMessage)?.type ===
				MESSAGE_TYPES.applyAction
			) {
				const action = (runtimeMessage as ApplyActionMessage).payload.action;
				const nextSpeed = await registry.applyAction(action);
				if (nextSpeed !== null) {
					showActionToast(action, nextSpeed);
				}
				return registry.getState();
			}

			if (
				(runtimeMessage as ApplyExactSpeedMessage)?.type ===
				MESSAGE_TYPES.applyExactSpeed
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
			browser.runtime.onMessage.addListener(handleRuntimeMessage);
			registry.start();

			settings = resolveSettings(await getSettings());
			await refreshDesiredSpeed();

			window.addEventListener("keydown", handleKeydown, true);
			window.addEventListener("load", emitCurrentState, true);
			window.addEventListener("pageshow", emitCurrentState, true);
			window.addEventListener("focus", emitCurrentState, true);
			document.addEventListener("visibilitychange", emitCurrentState, true);
			emitCurrentState();
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
			window.removeEventListener("load", emitCurrentState, true);
			window.removeEventListener("pageshow", emitCurrentState, true);
			window.removeEventListener("focus", emitCurrentState, true);
			document.removeEventListener("visibilitychange", emitCurrentState, true);
			browser.runtime.onMessage.removeListener(handleRuntimeMessage);
		};
	},
});
