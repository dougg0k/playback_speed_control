import type { PopupState } from "@/types/messages";
import type { AppSettings, ShortcutAction } from "@/types/settings";
import { clampSpeed } from "@/utils/numbers";

export interface MediaRegistryOptions {
	getSettings: () => AppSettings;
	getDesiredSpeed: () => number;
	onSpeedPersist: (speed: number) => void | Promise<void>;
	onStateChanged: (state: PopupState) => void;
	hostname: string;
}

interface ListenerBundle {
	onElementInteraction: () => void;
	onLoadedMetadata: () => void;
	onPlay: () => void;
	onPause: () => void;
	onPlaying: () => void;
	onSeeking: () => void;
	onSeeked: () => void;
	onRateChange: () => void;
}

function isVisibleVideo(element: HTMLMediaElement): boolean {
	if (!(element instanceof HTMLVideoElement)) {
		return true;
	}

	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return false;
	}

	const style = window.getComputedStyle(element);
	return style.visibility !== "hidden" && style.display !== "none";
}

function getMediaArea(element: HTMLMediaElement): number {
	if (!(element instanceof HTMLVideoElement)) {
		return 0;
	}

	const rect = element.getBoundingClientRect();
	return rect.width * rect.height;
}

function normalizeObservedSpeed(value: number): number | null {
	if (!Number.isFinite(value)) {
		return null;
	}

	const rounded = Number(value.toFixed(2));
	if (rounded < 0.1 || rounded > 16) {
		return null;
	}

	return rounded;
}

function isApproximatelyEqual(
	left: number,
	right: number,
	epsilon = 0.01,
): boolean {
	return Math.abs(left - right) <= epsilon;
}

export class MediaRegistry {
	private static readonly MANUAL_CHANGE_WINDOW_MS = 1500;
	private static readonly TARGET_INTERACTION_WINDOW_MS = 5000;
	private static readonly SEEK_SUPPRESSION_WINDOW_MS = 1200;

	private readonly options: MediaRegistryOptions;
	private readonly media = new Set<HTMLMediaElement>();
	private readonly listeners = new WeakMap<HTMLMediaElement, ListenerBundle>();
	private readonly interactionAt = new WeakMap<HTMLMediaElement, number>();
	private readonly registrationOrder = new WeakMap<HTMLMediaElement, number>();
	private readonly startupRestoreDone = new WeakSet<HTMLMediaElement>();
	private readonly expectedProgrammaticSpeed = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly transitionSuppressedUntil = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly pendingTransitionRestore = new WeakSet<HTMLMediaElement>();
	private readonly observer: MutationObserver;
	private readonly onDocumentInteraction = () => {
		this.lastDocumentInteractionAt = performance.now();
	};

	private activeMedia: HTMLMediaElement | null = null;
	private isStarted = false;
	private nextRegistrationOrder = 0;
	private lastDocumentInteractionAt = 0;
	private lastStateSignature = "";

	constructor(options: MediaRegistryOptions) {
		this.options = options;
		this.observer = new MutationObserver((mutations) => {
			let changed = false;

			for (const mutation of mutations) {
				changed = this.syncNodeList(mutation.addedNodes, true) || changed;
				changed = this.syncNodeList(mutation.removedNodes, false) || changed;
			}

			if (changed) {
				this.emitState();
			}
		});
	}

	start(): void {
		if (this.isStarted) {
			return;
		}

		this.isStarted = true;
		this.scanDocument();
		this.observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
		document.addEventListener("pointerdown", this.onDocumentInteraction, true);
		document.addEventListener("keydown", this.onDocumentInteraction, true);
		this.emitState();
	}

	stop(): void {
		if (!this.isStarted) {
			return;
		}

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
		this.activeMedia = null;
		this.isStarted = false;
		this.lastStateSignature = "";
	}

	updateSettings(): void {
		this.cleanupDisconnectedMedia();
		this.emitState();
	}

	canControlMedia(): boolean {
		return this.resolveTargetMedia() !== null;
	}

	getState(): PopupState {
		this.cleanupDisconnectedMedia();
		const target = this.resolveTargetMedia();
		const settings = this.options.getSettings();
		const currentSpeed = target ? this.getDisplayedSpeed(target) : null;

		return {
			hasMedia: this.countEligibleMedia() > 0,
			activeKind: target
				? target instanceof HTMLVideoElement
					? "video"
					: "audio"
				: null,
			currentSpeed,
			siteDisabled: !settings.enabled,
			hostname: this.options.hostname,
			mediaCount: this.countEligibleMedia(),
		};
	}

	async applyAction(action: ShortcutAction): Promise<number | null> {
		const target = this.resolveTargetMedia();
		const settings = this.options.getSettings();
		if (!settings.enabled || !target) {
			return null;
		}

		const baseSpeed = this.getBaseSpeed(target);
		let nextSpeed = baseSpeed;

		switch (action) {
			case "increase":
				nextSpeed = clampSpeed(baseSpeed + settings.speedStep);
				break;
			case "decrease":
				nextSpeed = clampSpeed(baseSpeed - settings.speedStep);
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
		const target = this.resolveTargetMedia();
		const settings = this.options.getSettings();
		if (!settings.enabled || !target) {
			return null;
		}

		const nextSpeed = clampSpeed(speed);
		this.activeMedia = target;
		this.startupRestoreDone.add(target);
		this.pendingTransitionRestore.delete(target);
		this.setPlaybackRate(target, nextSpeed);
		await this.options.onSpeedPersist(nextSpeed);
		this.emitState();
		return nextSpeed;
	}

	private emitState(): void {
		const state = this.getState();
		const signature = JSON.stringify(state);
		if (signature === this.lastStateSignature) {
			return;
		}

		this.lastStateSignature = signature;
		this.options.onStateChanged(state);
	}

	private scanDocument(): void {
		const mediaElements = document.querySelectorAll("video, audio");
		for (const element of mediaElements) {
			this.registerMediaElement(element as HTMLMediaElement);
		}
	}

	private syncNodeList(nodes: NodeList, shouldRegister: boolean): boolean {
		let changed = false;
		for (const node of nodes) {
			changed = this.syncNode(node, shouldRegister) || changed;
		}
		return changed;
	}

	private syncNode(node: Node, shouldRegister: boolean): boolean {
		if (!(node instanceof Element)) {
			return false;
		}

		let changed = false;
		if (node instanceof HTMLVideoElement || node instanceof HTMLAudioElement) {
			changed = shouldRegister
				? this.registerMediaElement(node)
				: this.unregisterMediaElement(node);
		}

		const descendants = node.querySelectorAll("video, audio");
		for (const element of descendants) {
			changed = shouldRegister
				? this.registerMediaElement(element as HTMLMediaElement) || changed
				: this.unregisterMediaElement(element as HTMLMediaElement) || changed;
		}

		return changed;
	}

	private cleanupDisconnectedMedia(): void {
		for (const element of this.media) {
			if (element.isConnected) {
				continue;
			}

			this.detachListeners(element);
			this.media.delete(element);
			if (this.activeMedia === element) {
				this.activeMedia = null;
			}
		}
	}

	private isEligibleMedia(element: HTMLMediaElement): boolean {
		const settings = this.options.getSettings();
		if (!element.isConnected) {
			return false;
		}

		if (!settings.workOnAudio && element instanceof HTMLAudioElement) {
			return false;
		}

		return true;
	}

	private countEligibleMedia(): number {
		let count = 0;
		for (const element of this.media) {
			if (this.isEligibleMedia(element)) {
				count += 1;
			}
		}
		return count;
	}

	private getInteractionAt(element: HTMLMediaElement): number {
		return this.interactionAt.get(element) ?? 0;
	}

	private getRegistrationOrder(element: HTMLMediaElement): number {
		return this.registrationOrder.get(element) ?? Number.MAX_SAFE_INTEGER;
	}

	private hasRecentTargetInteraction(element: HTMLMediaElement): boolean {
		const at = this.getInteractionAt(element);
		return (
			at > 0 &&
			performance.now() - at <= MediaRegistry.TARGET_INTERACTION_WINDOW_MS
		);
	}

	private isBetterTarget(
		candidate: HTMLMediaElement,
		current: HTMLMediaElement,
	): boolean {
		const candidateRecent = this.hasRecentTargetInteraction(candidate);
		const currentRecent = this.hasRecentTargetInteraction(current);
		if (candidateRecent !== currentRecent) {
			return candidateRecent;
		}

		const candidateInteraction = this.getInteractionAt(candidate);
		const currentInteraction = this.getInteractionAt(current);
		if (candidateInteraction !== currentInteraction) {
			return candidateInteraction > currentInteraction;
		}

		if (candidate === this.activeMedia || current === this.activeMedia) {
			return candidate === this.activeMedia;
		}

		const candidatePlayingVideo =
			candidate instanceof HTMLVideoElement &&
			!candidate.paused &&
			isVisibleVideo(candidate);
		const currentPlayingVideo =
			current instanceof HTMLVideoElement &&
			!current.paused &&
			isVisibleVideo(current);
		if (candidatePlayingVideo !== currentPlayingVideo) {
			return candidatePlayingVideo;
		}

		const candidateVisibleVideo =
			candidate instanceof HTMLVideoElement && isVisibleVideo(candidate);
		const currentVisibleVideo =
			current instanceof HTMLVideoElement && isVisibleVideo(current);
		if (candidateVisibleVideo !== currentVisibleVideo) {
			return candidateVisibleVideo;
		}

		if (candidate.paused !== current.paused) {
			return !candidate.paused;
		}

		if (
			candidate instanceof HTMLVideoElement !==
			current instanceof HTMLVideoElement
		) {
			return candidate instanceof HTMLVideoElement;
		}

		const candidateArea = getMediaArea(candidate);
		const currentArea = getMediaArea(current);
		if (candidateArea !== currentArea) {
			return candidateArea > currentArea;
		}

		return (
			this.getRegistrationOrder(candidate) < this.getRegistrationOrder(current)
		);
	}

	private resolveTargetMedia(
		preferred: HTMLMediaElement | null = null,
	): HTMLMediaElement | null {
		this.cleanupDisconnectedMedia();

		let winner: HTMLMediaElement | null = null;
		for (const element of this.media) {
			if (!this.isEligibleMedia(element)) {
				continue;
			}

			if (preferred && element === preferred) {
				this.activeMedia = element;
				return element;
			}

			if (!winner || this.isBetterTarget(element, winner)) {
				winner = element;
			}
		}

		this.activeMedia = winner;
		return winner;
	}

	private getBaseSpeed(element: HTMLMediaElement): number {
		return (
			normalizeObservedSpeed(element.playbackRate) ??
			clampSpeed(this.options.getDesiredSpeed())
		);
	}

	private setPlaybackRate(element: HTMLMediaElement, speed: number): void {
		const nextSpeed = clampSpeed(speed);
		const currentSpeed = normalizeObservedSpeed(element.playbackRate);
		if (
			currentSpeed !== null &&
			isApproximatelyEqual(currentSpeed, nextSpeed)
		) {
			return;
		}

		this.expectedProgrammaticSpeed.set(element, nextSpeed);
		element.playbackRate = nextSpeed;
	}

	private suppressExternalRateAdoption(element: HTMLMediaElement): void {
		this.transitionSuppressedUntil.set(
			element,
			performance.now() + MediaRegistry.SEEK_SUPPRESSION_WINDOW_MS,
		);
	}

	private isExternalRateAdoptionSuppressed(element: HTMLMediaElement): boolean {
		if (element.seeking) {
			return true;
		}

		const suppressedUntil = this.transitionSuppressedUntil.get(element) ?? 0;
		return suppressedUntil > performance.now();
	}

	private queueTransitionRestore(element: HTMLMediaElement): void {
		this.pendingTransitionRestore.add(element);
	}

	private clearTransitionRestore(element: HTMLMediaElement): void {
		this.pendingTransitionRestore.delete(element);
	}

	private hasPendingTransitionRestore(element: HTMLMediaElement): boolean {
		return this.pendingTransitionRestore.has(element);
	}

	private getDisplayedSpeed(element: HTMLMediaElement): number | null {
		const observedSpeed = normalizeObservedSpeed(element.playbackRate);
		if (!this.hasPendingTransitionRestore(element)) {
			return observedSpeed;
		}

		const desiredSpeed = clampSpeed(this.options.getDesiredSpeed());
		if (observedSpeed === null) {
			return desiredSpeed;
		}

		return isApproximatelyEqual(observedSpeed, desiredSpeed)
			? observedSpeed
			: desiredSpeed;
	}

	private shouldAdoptExternalRateChange(
		element: HTMLMediaElement,
		speed: number,
	): boolean {
		if (!this.options.getSettings().enabled) {
			return false;
		}

		if (this.resolveTargetMedia(element) !== element) {
			return false;
		}

		if (this.isExternalRateAdoptionSuppressed(element)) {
			return false;
		}

		if (
			performance.now() - this.lastDocumentInteractionAt >
			MediaRegistry.MANUAL_CHANGE_WINDOW_MS
		) {
			return false;
		}

		const desiredSpeed = clampSpeed(this.options.getDesiredSpeed());
		return !isApproximatelyEqual(speed, desiredSpeed);
	}

	private restoreDesiredSpeed(element: HTMLMediaElement): void {
		const settings = this.options.getSettings();
		if (!settings.enabled || !settings.forceSavedSpeedOnLoad) {
			return;
		}

		if (this.resolveTargetMedia(element) !== element) {
			return;
		}

		const desiredSpeed = clampSpeed(this.options.getDesiredSpeed());
		const currentSpeed = normalizeObservedSpeed(element.playbackRate);
		if (
			currentSpeed !== null &&
			isApproximatelyEqual(currentSpeed, desiredSpeed)
		) {
			return;
		}

		this.setPlaybackRate(element, desiredSpeed);
	}

	private restoreStartupSpeed(element: HTMLMediaElement): void {
		if (this.startupRestoreDone.has(element)) {
			return;
		}

		this.startupRestoreDone.add(element);
		this.restoreDesiredSpeed(element);
	}

	private restoreSpeedAfterTransition(element: HTMLMediaElement): void {
		if (!this.hasPendingTransitionRestore(element)) {
			return;
		}

		this.clearTransitionRestore(element);
		this.restoreDesiredSpeed(element);
	}

	private registerMediaElement(element: HTMLMediaElement): boolean {
		if (this.media.has(element)) {
			return false;
		}

		this.media.add(element);
		this.registrationOrder.set(element, this.nextRegistrationOrder++);

		const onElementInteraction = () => {
			const now = performance.now();
			this.lastDocumentInteractionAt = now;
			this.interactionAt.set(element, now);
			this.activeMedia = element;
			this.emitState();
		};

		const onLoadedMetadata = () => {
			this.activeMedia = this.resolveTargetMedia(element);
			this.emitState();
		};

		const onPlay = () => {
			this.activeMedia = element;
			this.suppressExternalRateAdoption(element);
			this.queueTransitionRestore(element);
		};

		const onPause = () => {
			this.activeMedia = element;
			this.suppressExternalRateAdoption(element);
		};

		const onPlaying = () => {
			this.activeMedia = element;
			this.restoreStartupSpeed(element);
			this.restoreSpeedAfterTransition(element);
			this.emitState();
		};

		const onSeeking = () => {
			this.activeMedia = element;
			this.queueTransitionRestore(element);
			this.suppressExternalRateAdoption(element);
		};

		const onSeeked = () => {
			this.activeMedia = element;
			this.suppressExternalRateAdoption(element);
			this.restoreSpeedAfterTransition(element);
			this.emitState();
		};

		const onRateChange = () => {
			const observedSpeed = normalizeObservedSpeed(element.playbackRate);
			if (observedSpeed === null) {
				this.emitState();
				return;
			}

			const expectedSpeed = this.expectedProgrammaticSpeed.get(element);
			if (typeof expectedSpeed === "number") {
				this.expectedProgrammaticSpeed.delete(element);
				if (isApproximatelyEqual(observedSpeed, expectedSpeed)) {
					this.emitState();
					return;
				}
			}

			if (!this.shouldAdoptExternalRateChange(element, observedSpeed)) {
				if (
					!isApproximatelyEqual(
						observedSpeed,
						clampSpeed(this.options.getDesiredSpeed()),
					)
				) {
					this.queueTransitionRestore(element);
				}
				this.emitState();
				return;
			}

			this.activeMedia = element;
			void this.options.onSpeedPersist(observedSpeed);
			this.emitState();
		};

		const listeners: ListenerBundle = {
			onElementInteraction,
			onLoadedMetadata,
			onPlay,
			onPause,
			onPlaying,
			onSeeking,
			onSeeked,
			onRateChange,
		};

		element.addEventListener("pointerdown", onElementInteraction, true);
		element.addEventListener("focus", onElementInteraction, true);
		element.addEventListener("loadedmetadata", onLoadedMetadata, true);
		element.addEventListener("play", onPlay, true);
		element.addEventListener("pause", onPause, true);
		element.addEventListener("playing", onPlaying, true);
		element.addEventListener("seeking", onSeeking, true);
		element.addEventListener("seeked", onSeeked, true);
		element.addEventListener("ratechange", onRateChange, true);
		this.listeners.set(element, listeners);

		if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
			this.activeMedia = this.resolveTargetMedia(element);
		}

		return true;
	}

	private unregisterMediaElement(element: HTMLMediaElement): boolean {
		if (!this.media.has(element)) {
			return false;
		}

		this.detachListeners(element);
		this.media.delete(element);
		if (this.activeMedia === element) {
			this.activeMedia = null;
		}
		return true;
	}

	private detachListeners(element: HTMLMediaElement): void {
		const listeners = this.listeners.get(element);
		if (!listeners) {
			return;
		}

		element.removeEventListener(
			"pointerdown",
			listeners.onElementInteraction,
			true,
		);
		element.removeEventListener("focus", listeners.onElementInteraction, true);
		element.removeEventListener(
			"loadedmetadata",
			listeners.onLoadedMetadata,
			true,
		);
		element.removeEventListener("play", listeners.onPlay, true);
		element.removeEventListener("pause", listeners.onPause, true);
		element.removeEventListener("playing", listeners.onPlaying, true);
		element.removeEventListener("seeking", listeners.onSeeking, true);
		element.removeEventListener("seeked", listeners.onSeeked, true);
		element.removeEventListener("ratechange", listeners.onRateChange, true);
		this.listeners.delete(element);
	}
}
