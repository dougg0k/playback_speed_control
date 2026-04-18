import { MESSAGE_TYPES } from "@/constants/extension";
import {
	getRememberedSpeed,
	getSettings,
	listenForSettingsChanges,
	setRememberedSpeed,
} from "@/core/settings";
import { MediaRegistry } from "@/core/mediaRegistry";
import { isEditableTarget, matchShortcutAction } from "@/core/shortcuts";
import { isHostnameDisabled } from "@/core/siteRules";
import { ToastController } from "@/core/toast";
import type {
	ApplyActionMessage,
	ApplyExactSpeedMessage,
	GetStateMessage,
	PopupState,
	RuntimeMessage,
} from "@/types/messages";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { formatSpeed } from "@/utils/numbers";
import { getCurrentHostname } from "@/utils/urls";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

function nodeHasMedia(node: Node | null): boolean {
	if (!(node instanceof Element)) {
		return false;
	}

	if (node instanceof HTMLVideoElement || node instanceof HTMLAudioElement) {
		return true;
	}

	return Boolean(node.querySelector("video, audio"));
}

function documentHasMedia(): boolean {
	return Boolean(document.querySelector("video, audio"));
}

export default defineContentScript({
	matches: ["<all_urls>"],
	allFrames: true,
	runAt: "document_end",
	main() {
		const hostname = getCurrentHostname();
		const isTopFrame = window.top === window.self;
		const toast = new ToastController();

		const resolveSettings = (nextSettings: AppSettings): AppSettings => ({
			...nextSettings,
			enabled:
				nextSettings.enabled &&
				!isHostnameDisabled(hostname, nextSettings.disabledSites),
		});

		const loadDesiredSpeed = async (
			nextSettings: AppSettings,
		): Promise<number> => {
			if (!nextSettings.enabled) {
				return nextSettings.preferredSpeed;
			}

			const remembered = nextSettings.rememberLastSpeed
				? await getRememberedSpeed(hostname)
				: null;

			return remembered ?? nextSettings.preferredSpeed;
		};

		const createDormantState = (): PopupState => ({
			hasMedia: false,
			activeKind: null,
			currentSpeed: null,
			siteDisabled: !settings.enabled,
			hostname,
			mediaCount: 0,
		});

		let settings: AppSettings = resolveSettings(DEFAULT_SETTINGS);
		let desiredSpeed = settings.preferredSpeed;
		let registry: MediaRegistry | null = null;
		let bootstrapObserver: MutationObserver | null = null;

		const emitState = (state: PopupState) => {
			void browser.runtime.sendMessage({
				type: MESSAGE_TYPES.stateSnapshot,
				payload: state,
			} satisfies RuntimeMessage);
		};

		const emitDormantState = () => {
			if (!isTopFrame) {
				return;
			}
			emitState(createDormantState());
		};

		const stopBootstrapObserver = () => {
			bootstrapObserver?.disconnect();
			bootstrapObserver = null;
		};

		const ensureRegistry = (): MediaRegistry | null => {
			if (!settings.enabled) {
				return null;
			}

			if (registry) {
				return registry;
			}

			if (!documentHasMedia()) {
				return null;
			}

			registry = new MediaRegistry({
				getSettings: () => settings,
				getDesiredSpeed: () => desiredSpeed,
				hostname,
				onSpeedPersist: async (speed) => {
					desiredSpeed = speed;
					if (!settings.rememberLastSpeed) {
						return;
					}

					await setRememberedSpeed(hostname, speed);
				},
				onStateChanged: emitState,
			});
			registry.start();
			stopBootstrapObserver();
			return registry;
		};

		const startBootstrapObserver = () => {
			if (bootstrapObserver || registry || !document.documentElement) {
				return;
			}

			bootstrapObserver = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (!nodeHasMedia(node)) {
							continue;
						}

						ensureRegistry();
						return;
					}
				}
			});

			bootstrapObserver.observe(document.documentElement, {
				childList: true,
				subtree: true,
			});
		};

		const refreshDesiredSpeed = async (
			nextSettings: AppSettings,
		): Promise<void> => {
			settings = nextSettings;
			desiredSpeed = await loadDesiredSpeed(settings);

			if (!settings.enabled) {
				registry?.stop();
				registry = null;
				stopBootstrapObserver();
				emitDormantState();
				return;
			}

			if (registry) {
				registry.updateSettings();
				return;
			}

			if (ensureRegistry()) {
				return;
			}

			emitDormantState();
			startBootstrapObserver();
		};

		const showActionToast = (
			action: "increase" | "decrease" | "reset" | "preferred",
			speed: number,
		) => {
			if (!settings.toastEnabled) {
				return;
			}

			toast.show(action === "reset" ? "Reset to 1x" : formatSpeed(speed));
		};

		const handleShortcutAction = async (
			action: "increase" | "decrease" | "reset" | "preferred",
		) => {
			const activeRegistry = ensureRegistry();
			if (!activeRegistry) {
				return;
			}

			const nextSpeed = await activeRegistry.applyAction(action);
			if (nextSpeed !== null) {
				showActionToast(action, nextSpeed);
			}
		};

		const handleKeydown = (event: KeyboardEvent) => {
			if (!settings.enabled || isEditableTarget(event.target)) {
				return;
			}

			const action = matchShortcutAction(event, settings.shortcuts);
			if (!action) {
				return;
			}

			const activeRegistry = ensureRegistry();
			if (!activeRegistry || !activeRegistry.canControlMedia()) {
				return;
			}

			event.preventDefault();
			void handleShortcutAction(action);
		};

		const handleRuntimeMessage = async (message: unknown) => {
			const runtimeMessage = message as RuntimeMessage;
			const activeRegistry = ensureRegistry();

			if (
				(runtimeMessage as GetStateMessage)?.type === MESSAGE_TYPES.getState
			) {
				return (
					activeRegistry?.getState() ??
					(isTopFrame ? createDormantState() : null)
				);
			}

			if (
				(runtimeMessage as ApplyActionMessage)?.type ===
				MESSAGE_TYPES.applyAction
			) {
				if (!activeRegistry) {
					return null;
				}

				const action = (runtimeMessage as ApplyActionMessage).payload.action;
				const nextSpeed = await activeRegistry.applyAction(action);
				if (nextSpeed !== null) {
					showActionToast(action, nextSpeed);
				}
				return activeRegistry.getState();
			}

			if (
				(runtimeMessage as ApplyExactSpeedMessage)?.type ===
				MESSAGE_TYPES.applyExactSpeed
			) {
				if (!activeRegistry) {
					return null;
				}

				const nextSpeed = await activeRegistry.applyExactSpeed(
					(runtimeMessage as ApplyExactSpeedMessage).payload.speed,
				);
				if (nextSpeed !== null && settings.toastEnabled) {
					toast.show(formatSpeed(nextSpeed));
				}
				return activeRegistry.getState();
			}

			return undefined;
		};

		const initialize = async () => {
			browser.runtime.onMessage.addListener(handleRuntimeMessage);
			settings = resolveSettings(await getSettings());
			desiredSpeed = await loadDesiredSpeed(settings);

			if (!ensureRegistry()) {
				emitDormantState();
				if (settings.enabled) {
					startBootstrapObserver();
				}
			}

			window.addEventListener("keydown", handleKeydown, true);
		};

		const stopListeningToStorage = listenForSettingsChanges(
			async (nextSettings) => {
				await refreshDesiredSpeed(resolveSettings(nextSettings));
			},
		);

		void initialize();

		return () => {
			stopListeningToStorage();
			stopBootstrapObserver();
			registry?.stop();
			window.removeEventListener("keydown", handleKeydown, true);
			browser.runtime.onMessage.removeListener(handleRuntimeMessage);
		};
	},
});
