import type { AppSettings, ShortcutAction } from "@/types/settings";
import type { PopupState } from "@/types/messages";
import { clampSpeed, roundSpeed } from "@/utils/numbers";

export interface MediaRegistryOptions {
	getSettings: () => AppSettings;
	getDesiredSpeed: () => number;
	onSpeedPersist: (speed: number) => void | Promise<void>;
	onStateChanged: (state: PopupState) => void;
	hostname: string;
}

interface ListenerBundle {
	onMediaInteraction: () => void;
	onPlay: () => void;
	onLoadedMetadata: () => void;
	onRateChange: () => void;
}

function isVisible(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		style.visibility !== "hidden" &&
		style.display !== "none"
	);
}

function getElementArea(element: HTMLElement): number {
	const rect = element.getBoundingClientRect();
	return rect.width * rect.height;
}

function isPlayableMedia(element: HTMLMediaElement): boolean {
	return !(element instanceof HTMLVideoElement) || element.readyState >= 0;
}

export class MediaRegistry {
	private static readonly USER_INTERACTION_WINDOW_MS = 1500;
	private static readonly LIFECYCLE_RESTORE_WINDOW_MS = 1200;
	private static readonly SPEED_EPSILON = 0.01;

	private readonly options: MediaRegistryOptions;
	private readonly media = new Set<HTMLMediaElement>();
	private readonly listeners = new WeakMap<HTMLMediaElement, ListenerBundle>();
	private readonly observer: MutationObserver;
	private readonly programmaticSpeedChanges = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly lifecycleRestoreUntil = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly lifecycleStartedAt = new WeakMap<HTMLMediaElement, number>();
	private readonly onDocumentInteraction = () => {
		this.lastUserInteractionAt = performance.now();
	};
	private lastInteracted: HTMLMediaElement | null = null;
	private lastUserInteractionAt = 0;

	constructor(options: MediaRegistryOptions) {
		this.options = options;
		this.observer = new MutationObserver((mutations) => {
			let changed = false;

			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					changed = this.registerNode(node) || changed;
				});

				mutation.removedNodes.forEach((node) => {
					changed = this.unregisterNode(node) || changed;
				});
			}

			if (changed) {
				this.maybeApplyDesiredSpeed();
				this.emitState();
			}
		});
	}

	start(): void {
		this.registerNode(document.documentElement);
		this.observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
		document.addEventListener("pointerdown", this.onDocumentInteraction, true);
		document.addEventListener("keydown", this.onDocumentInteraction, true);
		this.applySettingsToMedia();
		this.emitState();
	}

	stop(): void {
		this.observer.disconnect();
		document.removeEventListener(
			"pointerdown",
			this.onDocumentInteraction,
			true,
		);
		document.removeEventListener("keydown", this.onDocumentInteraction, true);
		for (const element of this.media) {
			this.detachListeners(element);
		}
		this.media.clear();
		this.lastInteracted = null;
	}

	updateSettings(): void {
		this.cleanupDisconnectedMedia();
		this.applySettingsToMedia();
		this.emitState();
	}

	getState(): PopupState {
		this.registerNode(document.documentElement);
		this.cleanupDisconnectedMedia();
		const settings = this.options.getSettings();
		const active = this.getTargetMedia();
		const activeKind = active
			? active instanceof HTMLVideoElement
				? "video"
				: "audio"
			: null;

		return {
			hasMedia: this.getEligibleMedia().length > 0,
			activeKind,
			currentSpeed: active ? roundSpeed(active.playbackRate) : null,
			siteDisabled: !settings.enabled,
			hostname: this.options.hostname,
			mediaCount: this.getEligibleMedia().length,
		};
	}

	async applyAction(action: ShortcutAction): Promise<number | null> {
		this.registerNode(document.documentElement);
		const target = this.getTargetMedia();
		const settings = this.options.getSettings();
		if (!settings.enabled || !target) return null;

		let nextSpeed = target.playbackRate;

		switch (action) {
			case "increase":
				nextSpeed = clampSpeed(target.playbackRate + settings.speedStep);
				break;
			case "decrease":
				nextSpeed = clampSpeed(target.playbackRate - settings.speedStep);
				break;
			case "reset":
				nextSpeed = 1;
				break;
			case "preferred":
				nextSpeed = clampSpeed(settings.preferredSpeed);
				break;
		}

		return this.applyExactSpeed(nextSpeed);
	}

	async applyExactSpeed(speed: number): Promise<number | null> {
		this.registerNode(document.documentElement);
		const target = this.getTargetMedia();
		const settings = this.options.getSettings();
		if (!settings.enabled || !target) return null;

		const nextSpeed = clampSpeed(speed);
		this.setMediaSpeed(target, nextSpeed);
		this.lastInteracted = target;
		await this.options.onSpeedPersist(nextSpeed);
		this.emitState();
		return nextSpeed;
	}

	private emitState(): void {
		this.options.onStateChanged(this.getState());
	}

	private cleanupDisconnectedMedia(): void {
		for (const element of Array.from(this.media)) {
			if (!element.isConnected) {
				this.detachListeners(element);
				this.media.delete(element);
			}
		}

		if (this.lastInteracted && !this.lastInteracted.isConnected) {
			this.lastInteracted = null;
		}
	}

	private getEligibleMedia(): HTMLMediaElement[] {
		const settings = this.options.getSettings();

		return Array.from(this.media).filter((element) => {
			if (!element.isConnected) return false;
			if (!settings.workOnAudio && element instanceof HTMLAudioElement)
				return false;
			return isPlayableMedia(element);
		});
	}

	private getPrimaryMediaCandidate(
		eligibleMedia: HTMLMediaElement[],
	): HTMLMediaElement | null {
		if (eligibleMedia.length === 0) return null;

		const playingVisibleVideo = eligibleMedia.find(
			(element) =>
				element instanceof HTMLVideoElement &&
				!element.paused &&
				isVisible(element),
		);
		if (playingVisibleVideo) return playingVisibleVideo;

		const visibleByArea = eligibleMedia
			.filter((element) => isVisible(element))
			.sort((left, right) => getElementArea(right) - getElementArea(left));

		if (visibleByArea.length > 0) return visibleByArea[0];

		return eligibleMedia[0];
	}

	private isUsableLastInteracted(
		element: HTMLMediaElement,
		eligibleMedia: HTMLMediaElement[],
	): boolean {
		return (
			eligibleMedia.includes(element) &&
			(element instanceof HTMLAudioElement ||
				!element.paused ||
				isVisible(element))
		);
	}

	private getTargetMedia(): HTMLMediaElement | null {
		const eligibleMedia = this.getEligibleMedia();
		if (eligibleMedia.length === 0) return null;

		if (
			this.lastInteracted &&
			this.isUsableLastInteracted(this.lastInteracted, eligibleMedia)
		) {
			return this.lastInteracted;
		}

		return this.getPrimaryMediaCandidate(eligibleMedia);
	}

	private maybeApplyDesiredSpeed(): void {
		const settings = this.options.getSettings();
		if (!settings.enabled || !settings.forceSavedSpeedOnLoad) return;

		const desiredSpeed = this.options.getDesiredSpeed();
		const target = this.getTargetMedia();
		if (!target) return;

		this.setMediaSpeed(target, desiredSpeed);
	}

	private setMediaSpeed(element: HTMLMediaElement, speed: number): void {
		const nextSpeed = clampSpeed(speed);
		this.programmaticSpeedChanges.set(element, nextSpeed);
		element.defaultPlaybackRate = nextSpeed;
		element.playbackRate = nextSpeed;
	}

	private syncMediaDefaultSpeed(
		element: HTMLMediaElement,
		speed: number,
	): void {
		element.defaultPlaybackRate = clampSpeed(speed);
	}

	private shouldAdoptExternalRateChange(element: HTMLMediaElement): boolean {
		const now = performance.now();
		const recentlyInteracted =
			now - this.lastUserInteractionAt <=
			MediaRegistry.USER_INTERACTION_WINDOW_MS;
		const eligibleMedia = this.getEligibleMedia();
		const primaryCandidate = this.getPrimaryMediaCandidate(eligibleMedia);

		return (
			recentlyInteracted &&
			(this.lastInteracted === element || primaryCandidate === element)
		);
	}

	private markLifecycleRestoreWindow(element: HTMLMediaElement): void {
		const now = performance.now();
		this.lifecycleStartedAt.set(element, now);
		this.lifecycleRestoreUntil.set(
			element,
			now + MediaRegistry.LIFECYCLE_RESTORE_WINDOW_MS,
		);
	}

	private isWithinLifecycleRestoreWindow(element: HTMLMediaElement): boolean {
		return (this.lifecycleRestoreUntil.get(element) ?? 0) > performance.now();
	}

	private shouldTreatLifecycleRateChangeAsManual(
		element: HTMLMediaElement,
	): boolean {
		const lifecycleStartedAt = this.lifecycleStartedAt.get(element) ?? 0;
		const now = performance.now();
		const recentlyInteracted =
			now - this.lastUserInteractionAt <=
			MediaRegistry.USER_INTERACTION_WINDOW_MS;

		return (
			recentlyInteracted && this.lastUserInteractionAt > lifecycleStartedAt + 50
		);
	}

	private resetEligibleMediaToNormal(): void {
		for (const element of this.getEligibleMedia()) {
			this.setMediaSpeed(element, 1);
		}
	}

	private applySettingsToMedia(): void {
		const settings = this.options.getSettings();
		if (!settings.enabled) {
			this.resetEligibleMediaToNormal();
			return;
		}

		this.maybeApplyDesiredSpeed();
	}

	private registerNode(node: Node): boolean {
		let changed = false;

		const visit = (candidate: Node): void => {
			if (
				candidate instanceof HTMLVideoElement ||
				candidate instanceof HTMLAudioElement
			) {
				changed = this.registerMediaElement(candidate) || changed;
			}

			if (!(candidate instanceof Element || candidate instanceof ShadowRoot))
				return;

			const elements =
				"querySelectorAll" in candidate ? candidate.querySelectorAll("*") : [];
			elements.forEach((element) => {
				if (
					element instanceof HTMLVideoElement ||
					element instanceof HTMLAudioElement
				) {
					changed = this.registerMediaElement(element) || changed;
				}

				if (element.shadowRoot) {
					visit(element.shadowRoot);
				}
			});
		};

		visit(node);
		return changed;
	}

	private unregisterNode(node: Node): boolean {
		let changed = false;

		const visit = (candidate: Node): void => {
			if (
				candidate instanceof HTMLVideoElement ||
				candidate instanceof HTMLAudioElement
			) {
				changed = this.unregisterMediaElement(candidate) || changed;
			}

			if (!(candidate instanceof Element || candidate instanceof ShadowRoot))
				return;

			const elements =
				"querySelectorAll" in candidate ? candidate.querySelectorAll("*") : [];
			elements.forEach((element) => {
				if (
					element instanceof HTMLVideoElement ||
					element instanceof HTMLAudioElement
				) {
					changed = this.unregisterMediaElement(element) || changed;
				}

				if (element.shadowRoot) {
					visit(element.shadowRoot);
				}
			});
		};

		visit(node);
		return changed;
	}

	private registerMediaElement(element: HTMLMediaElement): boolean {
		if (this.media.has(element)) return false;
		this.media.add(element);

		const onMediaInteraction = () => {
			this.lastInteracted = element;
			this.emitState();
		};

		const onPlay = () => {
			this.lastInteracted = element;
			const settings = this.options.getSettings();
			this.markLifecycleRestoreWindow(element);
			if (!settings.enabled) {
				this.setMediaSpeed(element, 1);
			} else if (settings.forceSavedSpeedOnLoad) {
				this.setMediaSpeed(element, this.options.getDesiredSpeed());
			}
			this.emitState();
		};

		const onLoadedMetadata = () => {
			const settings = this.options.getSettings();
			this.markLifecycleRestoreWindow(element);
			if (!settings.enabled) {
				this.setMediaSpeed(element, 1);
			} else if (settings.forceSavedSpeedOnLoad) {
				this.setMediaSpeed(element, this.options.getDesiredSpeed());
			}
			this.emitState();
		};

		const onRateChange = () => {
			const expectedProgrammaticSpeed =
				this.programmaticSpeedChanges.get(element);
			if (typeof expectedProgrammaticSpeed === "number") {
				if (
					Math.abs(element.playbackRate - expectedProgrammaticSpeed) <=
					MediaRegistry.SPEED_EPSILON
				) {
					this.programmaticSpeedChanges.delete(element);
					this.emitState();
					return;
				}

				this.programmaticSpeedChanges.delete(element);
			}

			const settings = this.options.getSettings();
			const desiredSpeed = this.options.getDesiredSpeed();
			const eligibleMedia = this.getEligibleMedia();
			const primaryCandidate = this.getPrimaryMediaCandidate(eligibleMedia);
			const isTrackedTarget =
				this.lastInteracted === element || primaryCandidate === element;
			const withinLifecycleRestoreWindow =
				this.isWithinLifecycleRestoreWindow(element);

			if (!settings.enabled) {
				if (Math.abs(element.playbackRate - 1) > MediaRegistry.SPEED_EPSILON) {
					this.setMediaSpeed(element, 1);
				}
				this.emitState();
				return;
			}

			if (withinLifecycleRestoreWindow) {
				if (
					isTrackedTarget &&
					this.shouldTreatLifecycleRateChangeAsManual(element)
				) {
					this.lastInteracted = element;
					this.syncMediaDefaultSpeed(element, element.playbackRate);
					void this.options.onSpeedPersist(element.playbackRate);
					this.emitState();
					return;
				}

				if (
					settings.forceSavedSpeedOnLoad &&
					isTrackedTarget &&
					Math.abs(element.playbackRate - desiredSpeed) >
						MediaRegistry.SPEED_EPSILON
				) {
					this.setMediaSpeed(element, desiredSpeed);
					this.emitState();
					return;
				}

				this.emitState();
				return;
			}

			if (this.shouldAdoptExternalRateChange(element)) {
				this.lastInteracted = element;
				this.syncMediaDefaultSpeed(element, element.playbackRate);
				void this.options.onSpeedPersist(element.playbackRate);
				this.emitState();
				return;
			}

			if (
				settings.forceSavedSpeedOnLoad &&
				isTrackedTarget &&
				Math.abs(element.playbackRate - desiredSpeed) >
					MediaRegistry.SPEED_EPSILON
			) {
				this.setMediaSpeed(element, desiredSpeed);
				this.emitState();
				return;
			}

			this.emitState();
		};

		const listeners: ListenerBundle = {
			onMediaInteraction,
			onPlay,
			onLoadedMetadata,
			onRateChange,
		};

		element.addEventListener("pointerdown", onMediaInteraction, true);
		element.addEventListener("focus", onMediaInteraction, true);
		element.addEventListener("play", onPlay, true);
		element.addEventListener("loadedmetadata", onLoadedMetadata, true);
		element.addEventListener("ratechange", onRateChange, true);

		this.listeners.set(element, listeners);
		return true;
	}

	private unregisterMediaElement(element: HTMLMediaElement): boolean {
		if (!this.media.has(element)) return false;
		this.detachListeners(element);
		this.media.delete(element);
		if (this.lastInteracted === element) this.lastInteracted = null;
		return true;
	}

	private detachListeners(element: HTMLMediaElement): void {
		const listeners = this.listeners.get(element);
		if (!listeners) return;

		element.removeEventListener(
			"pointerdown",
			listeners.onMediaInteraction,
			true,
		);
		element.removeEventListener("focus", listeners.onMediaInteraction, true);
		element.removeEventListener("play", listeners.onPlay, true);
		element.removeEventListener(
			"loadedmetadata",
			listeners.onLoadedMetadata,
			true,
		);
		element.removeEventListener("ratechange", listeners.onRateChange, true);
		this.listeners.delete(element);
	}
}
