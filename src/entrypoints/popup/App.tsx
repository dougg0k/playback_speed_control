import { useEffect, useMemo, useRef, useState } from "react";
import { MESSAGE_TYPES, PORT_NAMES } from "@/constants/extension";
import { getSettings, updateSettings } from "@/core/settings";
import { isEditableTarget, matchShortcutAction } from "@/core/shortcuts";
import { normalizeRules } from "@/core/siteRules";
import type {
	ApplyTabActionMessage,
	ApplyTabExactSpeedMessage,
	GetTabStateMessage,
	PopupState,
	TabStateChangedMessage,
	TabStateResponse,
} from "@/types/messages";
import type { AppSettings } from "@/types/settings";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { formatSpeed } from "@/utils/numbers";
import { getHostnameFromUrl } from "@/utils/urls";
import { browser } from "wxt/browser";
import { ShortcutEditor } from "./components/ShortcutEditor";
import "./App.css";

interface PopupStatus {
	activeTabId: number | null;
	hostname: string;
	state: PopupState | null;
	unavailableReason: string | null;
}

function capitalize(value: string | null | undefined): string {
	if (!value) return "";
	return value.charAt(0).toUpperCase() + value.slice(1);
}

async function getActiveTab(): Promise<browser.Tabs.Tab | null> {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
	return tab ?? null;
}

function applyPopupState(
	current: PopupStatus,
	nextState: PopupState | null,
): PopupStatus {
	return {
		...current,
		hostname: nextState?.hostname || current.hostname,
		state: nextState,
		unavailableReason: nextState ? null : current.unavailableReason,
	};
}

async function requestTabState(tabId: number): Promise<PopupState | null> {
	try {
		const response = (await browser.runtime.sendMessage({
			type: MESSAGE_TYPES.getTabState,
			payload: { tabId },
		} satisfies GetTabStateMessage)) as TabStateResponse | null | undefined;
		return response?.state ?? null;
	} catch {
		return null;
	}
}

async function requestPopupStatus(
	tabId: number | null,
	hostname: string,
): Promise<PopupStatus> {
	if (!tabId) {
		return {
			activeTabId: null,
			hostname,
			state: null,
			unavailableReason: "No active tab.",
		};
	}

	const state = await requestTabState(tabId);

	return {
		activeTabId: tabId,
		hostname: state?.hostname || hostname,
		state,
		unavailableReason: null,
	};
}

function parseSpeedInput(input: string, fallback: number): number {
	const parsed = Number(input);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function App() {
	const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
	const [popupStatus, setPopupStatus] = useState<PopupStatus>({
		activeTabId: null,
		hostname: "",
		state: null,
		unavailableReason: null,
	});
	const [isExpanded, setIsExpanded] = useState(false);
	const [disabledSitesValue, setDisabledSitesValue] = useState("");
	const activeTabIdRef = useRef<number | null>(null);

	const displayedSpeed = useMemo(
		() => popupStatus.state?.currentSpeed ?? null,
		[popupStatus.state?.currentSpeed],
	);

	useEffect(() => {
		let isMounted = true;
		let port: browser.Runtime.Port | null = null;
		let handlePortMessage: ((message: unknown) => void) | null = null;

		void (async () => {
			const [loadedSettings, activeTab] = await Promise.all([
				getSettings(),
				getActiveTab(),
			]);
			if (!isMounted) return;

			const activeTabId = activeTab?.id ?? null;
			const hostname = getHostnameFromUrl(activeTab?.url);
			activeTabIdRef.current = activeTabId;

			setSettings(loadedSettings);
			setDisabledSitesValue(loadedSettings.disabledSites.join("\n"));
			setPopupStatus({
				activeTabId,
				hostname,
				state: null,
				unavailableReason: activeTabId ? null : "No active tab.",
			});

			port = browser.runtime.connect({ name: PORT_NAMES.popup });
			handlePortMessage = (message: unknown) => {
				const runtimeMessage = message as TabStateChangedMessage;
				if (runtimeMessage?.type !== MESSAGE_TYPES.tabStateChanged) return;
				if (activeTabIdRef.current !== runtimeMessage.payload.tabId) return;

				setPopupStatus((current) =>
					applyPopupState(current, runtimeMessage.payload.state),
				);
			};
			port.onMessage.addListener(handlePortMessage);

			const status = await requestPopupStatus(activeTabId, hostname);
			if (!isMounted) return;
			setPopupStatus(status);
		})();

		return () => {
			isMounted = false;
			if (port && handlePortMessage) {
				port.onMessage.removeListener(handlePortMessage);
				port.disconnect();
			}
		};
	}, []);

	const sendAction = async (
		message: ApplyTabActionMessage | ApplyTabExactSpeedMessage,
	) => {
		const tabId = popupStatus.activeTabId;
		if (!tabId) return;

		try {
			const response = (await browser.runtime.sendMessage(message)) as
				| TabStateResponse
				| null
				| undefined;

			if (response?.state) {
				setPopupStatus((current) => applyPopupState(current, response.state));
				return;
			}

			const refreshedState = await requestTabState(tabId);
			setPopupStatus((current) =>
				applyPopupState(current, refreshedState ?? current.state),
			);
		} catch {
			const refreshedState = await requestTabState(tabId);
			setPopupStatus((current) =>
				applyPopupState(current, refreshedState ?? current.state),
			);
		}
	};

	useEffect(() => {
		const handleKeydown = (event: KeyboardEvent) => {
			if (isEditableTarget(event.target)) return;
			if (!popupStatus.activeTabId) return;

			const action = matchShortcutAction(event, settings.shortcuts);
			if (!action) return;

			event.preventDefault();
			event.stopPropagation();
			void sendAction({
				type: MESSAGE_TYPES.applyTabAction,
				payload: { tabId: popupStatus.activeTabId, action },
			} satisfies ApplyTabActionMessage);
		};

		window.addEventListener("keydown", handleKeydown, true);
		return () => {
			window.removeEventListener("keydown", handleKeydown, true);
		};
	}, [settings.shortcuts, popupStatus.activeTabId]);
	const saveSettings = async (partial: Partial<AppSettings>) => {
		const nextSettings = await updateSettings(partial);
		setSettings(nextSettings);
		setDisabledSitesValue(nextSettings.disabledSites.join("\n"));
	};

	const currentHostname =
		popupStatus.state?.hostname || popupStatus.hostname || "";
	const currentSiteDisabled = currentHostname
		? settings.disabledSites.some(
				(rule) =>
					currentHostname === rule || currentHostname.endsWith(`.${rule}`),
			)
		: false;

	const sourceLabel = popupStatus.state?.hasMedia
		? [capitalize(popupStatus.state.activeKind) || "Media", currentHostname]
				.filter(Boolean)
				.join(" • ")
		: "";

	const toggleCurrentSite = async () => {
		if (!currentHostname) return;

		const nextRules = currentSiteDisabled
			? settings.disabledSites.filter((rule) => rule !== currentHostname)
			: normalizeRules([...settings.disabledSites, currentHostname]);

		await saveSettings({ disabledSites: nextRules });
	};

	return (
		<div className="popup-shell">
			<header className="popup-header">
				<div>
					<p className="eyebrow">Playback Speed Control</p>
				</div>
				<button
					className="ghost-button"
					type="button"
					onClick={() => setIsExpanded((value) => !value)}
				>
					{isExpanded ? "Hide settings" : "Show settings"}
				</button>
			</header>

			<section className="speed-strip">
				<div className="speed-readout">
					<span
						className="speed-value"
						aria-label={
							displayedSpeed === null
								? "Current speed unavailable"
								: `Current speed ${formatSpeed(displayedSpeed)}`
						}
					>
						{formatSpeed(displayedSpeed)}
					</span>
					{sourceLabel ? (
						<span className="speed-source">{sourceLabel}</span>
					) : null}
				</div>
			</section>

			<section className="control-card">
				<div className="control-row">
					<button
						className="control-button"
						type="button"
						disabled={!popupStatus.activeTabId}
						onClick={() => {
							if (!popupStatus.activeTabId) return;
							void sendAction({
								type: MESSAGE_TYPES.applyTabAction,
								payload: { tabId: popupStatus.activeTabId, action: "decrease" },
							} satisfies ApplyTabActionMessage);
						}}
					>
						−
					</button>
					<button
						className="control-button control-button-primary"
						type="button"
						disabled={!popupStatus.activeTabId}
						onClick={() => {
							if (!popupStatus.activeTabId) return;
							void sendAction({
								type: MESSAGE_TYPES.applyTabAction,
								payload: { tabId: popupStatus.activeTabId, action: "increase" },
							} satisfies ApplyTabActionMessage);
						}}
					>
						+
					</button>
					<button
						className="control-button"
						type="button"
						disabled={!popupStatus.activeTabId}
						onClick={() => {
							if (!popupStatus.activeTabId) return;
							void sendAction({
								type: MESSAGE_TYPES.applyTabAction,
								payload: { tabId: popupStatus.activeTabId, action: "reset" },
							} satisfies ApplyTabActionMessage);
						}}
					>
						Reset
					</button>
					<button
						className="control-button"
						type="button"
						disabled={!popupStatus.activeTabId}
						onClick={() => {
							if (!popupStatus.activeTabId) return;
							void sendAction({
								type: MESSAGE_TYPES.applyTabAction,
								payload: {
									tabId: popupStatus.activeTabId,
									action: "preferred",
								},
							} satisfies ApplyTabActionMessage);
						}}
					>
						Preferred
					</button>
				</div>

				<div className="inline-field-row">
					<label className="field field-inline">
						<span>Preferred speed</span>
						<input
							type="number"
							min="0.1"
							max="16"
							step="0.05"
							value={settings.preferredSpeed}
							onChange={(event) =>
								void saveSettings({
									preferredSpeed: parseSpeedInput(
										event.target.value,
										settings.preferredSpeed,
									),
								})
							}
						/>
					</label>

					<button
						className="site-toggle"
						type="button"
						disabled={!currentHostname}
						onClick={() => void toggleCurrentSite()}
					>
						{currentSiteDisabled
							? "Enable on this site"
							: "Disable on this site"}
					</button>
				</div>
			</section>

			{isExpanded ? (
				<section className="settings-panel">
					<div className="settings-group">
						<div className="section-heading">
							<h3>Playback</h3>
							<span>
								Keep the frequent adjustments compact and predictable.
							</span>
						</div>
						<div className="grid-two">
							<label className="field">
								<span>Step size</span>
								<input
									type="number"
									min="0.05"
									max="4"
									step="0.05"
									value={settings.speedStep}
									onChange={(event) =>
										void saveSettings({
											speedStep: parseSpeedInput(
												event.target.value,
												settings.speedStep,
											),
										})
									}
								/>
							</label>
							<label className="field">
								<span>Apply exact speed</span>
								<div className="action-field">
									<input
										type="number"
										min="0.1"
										max="16"
										step="0.05"
										defaultValue={settings.preferredSpeed}
										onKeyDown={(event) => {
											if (event.key !== "Enter") return;
											if (!popupStatus.activeTabId) return;

											const nextSpeed = parseSpeedInput(
												(event.currentTarget as HTMLInputElement).value,
												settings.preferredSpeed,
											);
											void sendAction({
												type: MESSAGE_TYPES.applyTabExactSpeed,
												payload: {
													tabId: popupStatus.activeTabId,
													speed: nextSpeed,
												},
											} satisfies ApplyTabExactSpeedMessage);
										}}
									/>
									<span className="input-hint">Press Enter</span>
								</div>
							</label>
						</div>
					</div>

					<div className="settings-group">
						<div className="section-heading">
							<h3>Persistence</h3>
							<span>
								Control what speed is remembered for this host and how the
								selected speed gets reused on new media.
							</span>
						</div>
						<label className="toggle-row">
							<div>
								<strong>Remember last speed</strong>
								<p>Store the last selected speed for this host.</p>
							</div>
							<input
								type="checkbox"
								checked={settings.rememberLastSpeed}
								onChange={(event) =>
									void saveSettings({ rememberLastSpeed: event.target.checked })
								}
							/>
						</label>

						<label className="toggle-row">
							<div>
								<strong>Auto-restore speed on new media</strong>
								<p>
									Apply the current selected speed when a new media element
									becomes active.
								</p>
							</div>
							<input
								type="checkbox"
								checked={settings.autoRestoreSpeedOnNewMedia}
								onChange={(event) =>
									void saveSettings({
										autoRestoreSpeedOnNewMedia: event.target.checked,
									})
								}
							/>
						</label>
					</div>

					<div className="settings-group">
						<div className="section-heading">
							<h3>Behavior</h3>
							<span>Keep the control surface focused and lightweight.</span>
						</div>
						<label className="toggle-row">
							<div>
								<strong>Work on audio too</strong>
								<p>Include standard HTML audio elements in targeting.</p>
							</div>
							<input
								type="checkbox"
								checked={settings.workOnAudio}
								onChange={(event) =>
									void saveSettings({ workOnAudio: event.target.checked })
								}
							/>
						</label>
						<label className="toggle-row">
							<div>
								<strong>Show toast</strong>
								<p>
									Display a subtle on-page toast after successful speed changes.
								</p>
							</div>
							<input
								type="checkbox"
								checked={settings.toastEnabled}
								onChange={(event) =>
									void saveSettings({ toastEnabled: event.target.checked })
								}
							/>
						</label>
					</div>

					<div className="settings-group">
						<div className="section-heading">
							<h3>Disabled sites</h3>
							<span>One host or domain per line.</span>
						</div>
						<textarea
							className="settings-textarea"
							value={disabledSitesValue}
							onChange={(event) => setDisabledSitesValue(event.target.value)}
							onBlur={() =>
								void saveSettings({
									disabledSites: normalizeRules(
										disabledSitesValue.split(/\r?\n/g),
									),
								})
							}
							rows={4}
						/>
					</div>

					<div className="settings-group">
						<div className="section-heading">
							<h3>Shortcuts</h3>
							<span>
								Single keys are faster, but may collide with site shortcuts.
							</span>
						</div>
						<ShortcutEditor
							shortcuts={settings.shortcuts}
							onChange={(shortcuts) => void saveSettings({ shortcuts })}
						/>
					</div>
				</section>
			) : null}
		</div>
	);
}

export default App;
