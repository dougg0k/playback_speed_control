import { useEffect, useMemo, useState } from "react";
import { getSettings, updateSettings } from "@/core/settings";
import { normalizeRules } from "@/core/siteRules";
import type { ContentRequestMessage, PopupState } from "@/types/messages";
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

async function getActiveTab(): Promise<browser.Tabs.Tab | null> {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
	return tab ?? null;
}

async function requestStateFromActiveTab(): Promise<PopupStatus> {
	const tab = await getActiveTab();
	const tabId = tab?.id ?? null;
	const hostname = getHostnameFromUrl(tab?.url);

	if (!tabId) {
		return {
			activeTabId: null,
			hostname,
			state: null,
			unavailableReason: "No active tab",
		};
	}

	try {
		const state = (await browser.tabs.sendMessage(tabId, {
			type: "PSC_GET_STATE",
		} satisfies ContentRequestMessage)) as PopupState;

		return {
			activeTabId: tabId,
			hostname,
			state,
			unavailableReason: null,
		};
	} catch {
		return {
			activeTabId: tabId,
			hostname,
			state: null,
			unavailableReason: "No controllable media was found in this tab yet.",
		};
	}
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
	const [isReady, setIsReady] = useState(false);
	const [isSendingAction, setIsSendingAction] = useState(false);

	const displayedSpeed = useMemo(
		() => popupStatus.state?.currentSpeed ?? settings.preferredSpeed,
		[popupStatus.state?.currentSpeed, settings.preferredSpeed],
	);

	useEffect(() => {
		void (async () => {
			const [loadedSettings, status] = await Promise.all([
				getSettings(),
				requestStateFromActiveTab(),
			]);

			setSettings(loadedSettings);
			setDisabledSitesValue(loadedSettings.disabledSites.join("\n"));
			setPopupStatus(status);
			setIsReady(true);
		})();
	}, []);

	const saveSettings = async (partial: Partial<AppSettings>) => {
		const nextSettings = await updateSettings(partial);
		setSettings(nextSettings);
		setDisabledSitesValue(nextSettings.disabledSites.join("\n"));
	};

	const sendAction = async (message: ContentRequestMessage) => {
		if (!popupStatus.activeTabId) return;
		setIsSendingAction(true);

		try {
			const state = (await browser.tabs.sendMessage(
				popupStatus.activeTabId,
				message,
			)) as PopupState;
			setPopupStatus((current) => ({
				...current,
				state,
				unavailableReason: null,
			}));
		} catch {
			setPopupStatus((current) => ({
				...current,
				state: null,
				unavailableReason:
					"This page is not currently exposing controllable media.",
			}));
		} finally {
			setIsSendingAction(false);
		}
	};

	const currentHostname =
		popupStatus.hostname || popupStatus.state?.hostname || "";
	const currentSiteDisabled = currentHostname
		? settings.disabledSites.some(
				(rule) =>
					currentHostname === rule || currentHostname.endsWith(`.${rule}`),
			)
		: false;

	const toggleCurrentSite = async () => {
		if (!currentHostname) return;

		const nextRules = currentSiteDisabled
			? settings.disabledSites.filter((rule) => rule !== currentHostname)
			: normalizeRules([...settings.disabledSites, currentHostname]);

		await saveSettings({ disabledSites: nextRules });
		const status = await requestStateFromActiveTab();
		setPopupStatus(status);
	};

	if (!isReady) {
		return (
			<div className="popup-shell">
				<div className="loading-state">Loading…</div>
			</div>
		);
	}

	return (
		<div className="popup-shell">
			<header className="popup-header">
				<div>
					<p className="eyebrow">Playback Speed Control</p>
					<h1>Speed</h1>
				</div>
				<button
					className="ghost-button"
					type="button"
					onClick={() => setIsExpanded((value) => !value)}
				>
					{isExpanded ? "Hide settings" : "Show settings"}
				</button>
			</header>

			<section className="hero-card">
				<div>
					<p className="muted-label">Current speed</p>
					<div className="speed-display">{formatSpeed(displayedSpeed)}</div>
				</div>

				<div className="hero-meta">
					<span
						className={`status-pill ${popupStatus.state?.hasMedia ? "is-active" : ""}`}
					>
						{popupStatus.state?.hasMedia
							? (popupStatus.state?.activeKind ?? "media")
							: "No media"}
					</span>
					{currentHostname ? (
						<span className="hostname">{currentHostname}</span>
					) : null}
				</div>
			</section>

			<section className="control-card">
				<div className="control-row">
					<button
						className="control-button"
						type="button"
						disabled={isSendingAction}
						onClick={() =>
							void sendAction({
								type: "PSC_APPLY_ACTION",
								payload: { action: "decrease" },
							})
						}
					>
						−
					</button>
					<button
						className="control-button control-button-primary"
						type="button"
						disabled={isSendingAction}
						onClick={() =>
							void sendAction({
								type: "PSC_APPLY_ACTION",
								payload: { action: "increase" },
							})
						}
					>
						+
					</button>
					<button
						className="control-button"
						type="button"
						disabled={isSendingAction}
						onClick={() =>
							void sendAction({
								type: "PSC_APPLY_ACTION",
								payload: { action: "reset" },
							})
						}
					>
						Reset
					</button>
					<button
						className="control-button"
						type="button"
						disabled={isSendingAction}
						onClick={() =>
							void sendAction({
								type: "PSC_APPLY_ACTION",
								payload: { action: "preferred" },
							})
						}
					>
						Preferred
					</button>
				</div>

				<div className="inline-field-row">
					<label className="field field-inline">
						<span>Preferred speed</span>
						<input
							type="number"
							min="0.07"
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

				{popupStatus.unavailableReason ? (
					<p className="hint-text">{popupStatus.unavailableReason}</p>
				) : null}
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
										min="0.07"
										max="16"
										step="0.05"
										defaultValue={settings.preferredSpeed}
										onKeyDown={(event) => {
											if (event.key !== "Enter") return;
											const nextSpeed = parseSpeedInput(
												(event.currentTarget as HTMLInputElement).value,
												settings.preferredSpeed,
											);
											void sendAction({
												type: "PSC_APPLY_EXACT_SPEED",
												payload: { speed: nextSpeed },
											});
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
								Control what speed is remembered and how it gets reused.
							</span>
						</div>

						<label className="toggle-row">
							<div>
								<strong>Remember last speed</strong>
								<p>Store the last extension-applied speed.</p>
							</div>
							<input
								type="checkbox"
								checked={settings.rememberLastSpeed}
								onChange={(event) =>
									void saveSettings({ rememberLastSpeed: event.target.checked })
								}
							/>
						</label>

						<label className="field">
							<span>Save scope</span>
							<select
								value={settings.saveScope}
								onChange={(event) =>
									void saveSettings({
										saveScope: event.target.value as AppSettings["saveScope"],
									})
								}
							>
								<option value="site">Per site</option>
								<option value="global">Global</option>
							</select>
						</label>

						<label className="toggle-row">
							<div>
								<strong>Auto-restore speed on new media</strong>
								<p>
									Reapply the saved or preferred speed when the site resets or
									recreates media.
								</p>
							</div>
							<input
								type="checkbox"
								checked={settings.forceSavedSpeedOnLoad}
								onChange={(event) =>
									void saveSettings({
										forceSavedSpeedOnLoad: event.target.checked,
									})
								}
							/>
						</label>
					</div>

					<div className="settings-group">
						<div className="section-heading">
							<h3>Behavior</h3>
							<span>Only enable the extra behaviors you actually want.</span>
						</div>

						<label className="toggle-row">
							<div>
								<strong>Audio support</strong>
								<p>
									Allow the extension to target audio elements as well as video.
								</p>
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
								<strong>Shortcut toast</strong>
								<p>
									Show a near-transparent confirmation after shortcut actions.
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
							<span>
								Use one hostname per line. Simple host/domain entries only.
							</span>
						</div>
						<label className="field">
							<span>Hostnames</span>
							<textarea
								rows={5}
								value={disabledSitesValue}
								onChange={(event) => setDisabledSitesValue(event.target.value)}
								onBlur={() =>
									void saveSettings({
										disabledSites: normalizeRules(
											disabledSitesValue.split(/\r?\n/),
										),
									})
								}
							/>
						</label>
					</div>

					<ShortcutEditor
						shortcuts={settings.shortcuts}
						onChange={(nextShortcuts) =>
							void saveSettings({ shortcuts: nextShortcuts })
						}
					/>
				</section>
			) : null}
		</div>
	);
}

export default App;
