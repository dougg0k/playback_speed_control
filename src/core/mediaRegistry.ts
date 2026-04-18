import type { PopupState } from "@/types/messages";
import type { AppSettings, ShortcutAction } from "@/types/settings";
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
	onLoadedMetadata: () => void;
	onCanPlay: () => void;
	onPlaying: () => void;
	onRateChange: () => void;
}

function isVisibleVideo(element: HTMLMediaElement): boolean {
	if (!(element instanceof HTMLVideoElement)) return true;
	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		style.visibility !== "hidden" &&
		style.display !== "none"
	);
}

function getMediaArea(element: HTMLMediaElement): number {
	if (!(element instanceof HTMLVideoElement)) return 0;
	const rect = element.getBoundingClientRect();
	return rect.width * rect.height;
}

function isPlayableMedia(element: HTMLMediaElement): boolean {
	return !(element instanceof HTMLVideoElement) || element.readyState >= 0;
}

function isApproximatelyEqual(
	left: number,
	right: number,
	epsilon: number,
): boolean {
	return Math.abs(left - right) <= epsilon;
}

export class MediaRegistry {
	private static readonly USER_INTERACTION_WINDOW_MS = 1200;
	private static readonly TARGET_INTERACTION_WINDOW_MS = 5000;
	private static readonly LIFECYCLE_RESTORE_WINDOW_MS = 1200;
	private static readonly SPEED_EPSILON = 0.01;

	private readonly options: MediaRegistryOptions;
	private readonly media = new Set<HTMLMediaElement>();
	private readonly listeners = new WeakMap<HTMLMediaElement, ListenerBundle>();
	private readonly observedRoots = new Map<Node, MutationObserver>();
	private readonly expectedProgrammaticSpeeds = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly pendingAdoptionFrames = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly lifecycleRestoreUntil = new WeakMap<
		HTMLMediaElement,
		number
	>();
	private readonly pendingLifecycleRestore = new WeakSet<HTMLMediaElement>();
	private readonly mediaInteractionAt = new WeakMap<HTMLMediaElement, number>();
	private readonly registrationOrder = new WeakMap<HTMLMediaElement, number>();
	private readonly extensionOwnedMedia = new WeakSet<HTMLMediaElement>();
	private readonly onDocumentInteraction = () => {
		const now = performance.now();
		this.lastUserInteractionAt = now;
		const target = this.resolveTargetMedia();
		if (target) {
			this.mediaInteractionAt.set(target, now);
		}
	};

	private activeMedia: HTMLMediaElement | null = null;
	private isStarted = false;
	private registryOrderCounter = 0;
	private lastUserInteractionAt = 0;
	private syncQueued = false;
	private lastStateSignature = "";

	constructor(options: MediaRegistryOptions) {
		this.options = options;
	}

	start(): void {
		if (this.isStarted) return;
		this.isStarted = true;
		this.ensureObservedRoot(document.documentElement);
		this.registerSubtree(document.documentElement);
		document.addEventListener("pointerdown", this.onDocumentInteraction, true);
		document.addEventListener("keydown", this.onDocumentInteraction, true);
		this.queueSync();
	}

	stop(): void {
		for (const observer of this.observedRoots.values()) {
			observer.disconnect();
		}
		this.observedRoots.clear();
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
		this.syncQueued = false;
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
		const settings = this.options.getSettings();
		const eligibleMedia = this.getEligibleMedia();
		const active = this.resolveTargetMedia();

		return {
			hasMedia: eligibleMedia.length > 0,
			activeKind: active
				? active instanceof HTMLVideoElement
					? "video"
					: "audio"
				: null,
			currentSpeed: active ? roundSpeed(active.playbackRate) : null,
			siteDisabled: !settings.enabled,
			hostname: this.options.hostname,
			mediaCount: eligibleMedia.length,
		};
	}

	async applyAction(action: ShortcutAction): Promise<number | null> {
		const settings = this.options.getSettings();
		const target = this.resolveTargetMedia();
		if (!settings.enabled || !target) return null;

		const baseSpeed = this.getActionBaseSpeed(target);
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
		const settings = this.options.getSettings();
		const target = this.resolveTargetMedia();
		if (!settings.enabled || !target) return null;

		const nextSpeed = clampSpeed(speed);
		this.activeMedia = target;
		this.setPlaybackRate(target, nextSpeed, { extensionOwned: true });
		await this.options.onSpeedPersist(nextSpeed);
		this.emitState();
		return nextSpeed;
	}

	private emitState(): void {
		const state = this.getState();
		const signature = JSON.stringify(state);
		if (signature === this.lastStateSignature) return;
		this.lastStateSignature = signature;
		this.options.onStateChanged(state);
	}

	private queueSync(): void {
		if (this.syncQueued) return;
		this.syncQueued = true;
		queueMicrotask(() => {
			this.syncQueued = false;
			this.cleanupDisconnectedMedia();
			this.resolveTargetMedia();
			this.emitState();
		});
	}

	private ensureObservedRoot(root: Node | null): void {
		if (!root || this.observedRoots.has(root)) return;

		const observer = new MutationObserver((mutations) => {
			let changed = false;

			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					changed = this.registerSubtree(node) || changed;
				}

				for (const node of Array.from(mutation.removedNodes)) {
					changed = this.unregisterSubtree(node) || changed;
				}
			}

			if (changed) {
				this.queueSync();
			}
		});

		observer.observe(root, {
			childList: true,
			subtree: true,
		});
		this.observedRoots.set(root, observer);
	}

	private cleanupDisconnectedMedia(): void {
		for (const element of Array.from(this.media)) {
			if (!element.isConnected) {
				this.detachListeners(element);
				this.media.delete(element);
			}
		}

		if (this.activeMedia && !this.activeMedia.isConnected) {
			this.activeMedia = null;
		}
	}

	private getEligibleMedia(): HTMLMediaElement[] {
		const settings = this.options.getSettings();
		return Array.from(this.media).filter((element) => {
			if (!element.isConnected) return false;
			if (!settings.workOnAudio && element instanceof HTMLAudioElement) {
				return false;
			}
			return isPlayableMedia(element);
		});
	}

	private getRegistrationOrder(element: HTMLMediaElement): number {
		return this.registrationOrder.get(element) ?? Number.MAX_SAFE_INTEGER;
	}

	private getInteractionTimestamp(element: HTMLMediaElement): number {
		return this.mediaInteractionAt.get(element) ?? 0;
	}

	private compareCandidates(
		left: HTMLMediaElement,
		right: HTMLMediaElement,
	): number {
		const interactionDiff =
			this.getInteractionTimestamp(right) - this.getInteractionTimestamp(left);
		if (interactionDiff !== 0) return interactionDiff;

		if (left.paused !== right.paused) {
			return left.paused ? 1 : -1;
		}

		const leftVisible = isVisibleVideo(left);
		const rightVisible = isVisibleVideo(right);
		if (leftVisible !== rightVisible) {
			return rightVisible ? 1 : -1;
		}

		const areaDiff = getMediaArea(right) - getMediaArea(left);
		if (areaDiff !== 0) return areaDiff;

		if (
			left instanceof HTMLVideoElement !==
			right instanceof HTMLVideoElement
		) {
			return left instanceof HTMLVideoElement ? -1 : 1;
		}

		return this.getRegistrationOrder(left) - this.getRegistrationOrder(right);
	}

	private sortCandidates(candidates: HTMLMediaElement[]): HTMLMediaElement[] {
		return [...candidates].sort((left, right) =>
			this.compareCandidates(left, right),
		);
	}

	private pickFromBucket(
		candidates: HTMLMediaElement[],
	): HTMLMediaElement | null {
		return this.sortCandidates(candidates)[0] ?? null;
	}

	private resolveTargetMedia(
		preferred: HTMLMediaElement | null = null,
	): HTMLMediaElement | null {
		const eligibleMedia = this.getEligibleMedia();
		if (eligibleMedia.length === 0) {
			this.activeMedia = null;
			return null;
		}

		if (preferred && eligibleMedia.includes(preferred)) {
			this.activeMedia = preferred;
			return preferred;
		}

		const now = performance.now();
		const recentlyInteracted = eligibleMedia.filter((element) => {
			const interactedAt = this.getInteractionTimestamp(element);
			return (
				interactedAt > 0 &&
				now - interactedAt <= MediaRegistry.TARGET_INTERACTION_WINDOW_MS
			);
		});
		const recentTarget = this.pickFromBucket(recentlyInteracted);
		if (recentTarget) {
			this.activeMedia = recentTarget;
			return recentTarget;
		}

		if (this.activeMedia && eligibleMedia.includes(this.activeMedia)) {
			const currentActive = this.activeMedia;
			if (!currentActive.paused || isVisibleVideo(currentActive)) {
				return currentActive;
			}
		}

		const playingVisibleVideos = eligibleMedia.filter(
			(element) =>
				element instanceof HTMLVideoElement &&
				!element.paused &&
				isVisibleVideo(element),
		);
		const playingVisibleVideoTarget = this.pickFromBucket(playingVisibleVideos);
		if (playingVisibleVideoTarget) {
			this.activeMedia = playingVisibleVideoTarget;
			return playingVisibleVideoTarget;
		}

		const visibleVideos = eligibleMedia.filter(
			(element) =>
				element instanceof HTMLVideoElement && isVisibleVideo(element),
		);
		const visibleVideoTarget = this.pickFromBucket(visibleVideos);
		if (visibleVideoTarget) {
			this.activeMedia = visibleVideoTarget;
			return visibleVideoTarget;
		}

		const playingMedia = eligibleMedia.filter((element) => !element.paused);
		const playingMediaTarget = this.pickFromBucket(playingMedia);
		if (playingMediaTarget) {
			this.activeMedia = playingMediaTarget;
			return playingMediaTarget;
		}

		const fallback = this.pickFromBucket(eligibleMedia);
		this.activeMedia = fallback;
		return fallback;
	}

	private getDesiredSpeed(): number {
		return clampSpeed(this.options.getDesiredSpeed());
	}

	private readObservedPlaybackRate(element: HTMLMediaElement): number | null {
		const observed = element.playbackRate;
		if (!Number.isFinite(observed) || observed <= 0) {
			return null;
		}
		return observed;
	}

	private getObservedPlaybackRate(element: HTMLMediaElement): number | null {
		const observed = this.readObservedPlaybackRate(element);
		return observed === null ? null : clampSpeed(observed);
	}

	private getActionBaseSpeed(element: HTMLMediaElement): number {
		const observed = this.getObservedPlaybackRate(element);
		if (observed !== null) {
			return observed;
		}
		return this.getDesiredSpeed();
	}

	private markLifecycleWindow(element: HTMLMediaElement): void {
		this.lifecycleRestoreUntil.set(
			element,
			performance.now() + MediaRegistry.LIFECYCLE_RESTORE_WINDOW_MS,
		);
		this.pendingLifecycleRestore.add(element);
	}

	private isWithinLifecycleRestoreWindow(element: HTMLMediaElement): boolean {
		return (this.lifecycleRestoreUntil.get(element) ?? 0) > performance.now();
	}

	private isLikelyManualRateChange(element: HTMLMediaElement): boolean {
		const interactedAt = this.getInteractionTimestamp(element);
		return (
			interactedAt > 0 &&
			performance.now() - interactedAt <=
				MediaRegistry.USER_INTERACTION_WINDOW_MS
		);
	}

	private shouldMaintainDesiredSpeed(element: HTMLMediaElement): boolean {
		const settings = this.options.getSettings();
		return (
			settings.forceSavedSpeedOnLoad || this.extensionOwnedMedia.has(element)
		);
	}

	private setPlaybackRate(
		element: HTMLMediaElement,
		speed: number,
		options: { extensionOwned: boolean },
	): void {
		const nextSpeed = clampSpeed(speed);
		const observed = this.getObservedPlaybackRate(element);
		if (
			observed !== null &&
			isApproximatelyEqual(observed, nextSpeed, MediaRegistry.SPEED_EPSILON)
		) {
			if (options.extensionOwned) {
				this.extensionOwnedMedia.add(element);
			}
			return;
		}

		this.expectedProgrammaticSpeeds.set(element, nextSpeed);
		if (options.extensionOwned) {
			this.extensionOwnedMedia.add(element);
		}
		element.playbackRate = nextSpeed;
	}

	private enforceDesiredSpeed(element: HTMLMediaElement): void {
		this.setPlaybackRate(element, this.getDesiredSpeed(), {
			extensionOwned: true,
		});
	}

	private adoptExternalSpeed(element: HTMLMediaElement): void {
		const adoptedSpeed = this.getObservedPlaybackRate(element);
		if (adoptedSpeed === null) {
			return;
		}
		this.activeMedia = element;
		this.extensionOwnedMedia.add(element);
		void this.options.onSpeedPersist(adoptedSpeed);
	}

	private cancelPendingAdoption(element: HTMLMediaElement): void {
		const frameId = this.pendingAdoptionFrames.get(element);
		if (typeof frameId === "number") {
			cancelAnimationFrame(frameId);
			this.pendingAdoptionFrames.delete(element);
		}
	}

	private scheduleExternalSpeedAdoption(element: HTMLMediaElement): void {
		this.cancelPendingAdoption(element);
		const frameId = requestAnimationFrame(() => {
			this.pendingAdoptionFrames.delete(element);
			if (!this.media.has(element)) {
				return;
			}

			const target = this.resolveTargetMedia(element);
			if (target !== element) {
				this.emitState();
				return;
			}

			const observedSpeed = this.getObservedPlaybackRate(element);
			if (observedSpeed === null) {
				this.emitState();
				return;
			}

			this.adoptExternalSpeed(element);
			this.emitState();
		});
		this.pendingAdoptionFrames.set(element, frameId);
	}

	private handleLifecycleReady(element: HTMLMediaElement): void {
		const target = this.resolveTargetMedia(element);
		if (target !== element) {
			this.emitState();
			return;
		}

		if (
			!this.pendingLifecycleRestore.has(element) &&
			!this.isWithinLifecycleRestoreWindow(element)
		) {
			this.emitState();
			return;
		}

		const settings = this.options.getSettings();
		if (settings.enabled && settings.forceSavedSpeedOnLoad) {
			const desiredSpeed = this.getDesiredSpeed();
			const observedSpeed = this.getObservedPlaybackRate(element);
			if (
				observedSpeed === null ||
				!isApproximatelyEqual(
					observedSpeed,
					desiredSpeed,
					MediaRegistry.SPEED_EPSILON,
				)
			) {
				this.enforceDesiredSpeed(element);
			}
		}

		this.pendingLifecycleRestore.delete(element);
		this.emitState();
	}

	private registerSubtree(node: Node): boolean {
		let changed = false;

		const visit = (candidate: Node): void => {
			if (
				candidate instanceof HTMLVideoElement ||
				candidate instanceof HTMLAudioElement
			) {
				changed = this.registerMediaElement(candidate) || changed;
			}

			if (!(candidate instanceof Element || candidate instanceof ShadowRoot)) {
				return;
			}

			const ownerDocument = candidate.ownerDocument ?? document;
			const walker = ownerDocument.createTreeWalker(
				candidate,
				NodeFilter.SHOW_ELEMENT,
			);

			let current: Node | null = walker.currentNode;
			while (current) {
				if (
					current instanceof HTMLVideoElement ||
					current instanceof HTMLAudioElement
				) {
					changed = this.registerMediaElement(current) || changed;
				}

				if (current instanceof Element && current.shadowRoot) {
					this.ensureObservedRoot(current.shadowRoot);
					visit(current.shadowRoot);
				}

				current = walker.nextNode();
			}
		};

		visit(node);
		return changed;
	}

	private unregisterSubtree(node: Node): boolean {
		let changed = false;

		const visit = (candidate: Node): void => {
			if (
				candidate instanceof HTMLVideoElement ||
				candidate instanceof HTMLAudioElement
			) {
				changed = this.unregisterMediaElement(candidate) || changed;
			}

			if (!(candidate instanceof Element || candidate instanceof ShadowRoot)) {
				return;
			}

			const ownerDocument = candidate.ownerDocument ?? document;
			const walker = ownerDocument.createTreeWalker(
				candidate,
				NodeFilter.SHOW_ELEMENT,
			);

			let current: Node | null = walker.currentNode;
			while (current) {
				if (
					current instanceof HTMLVideoElement ||
					current instanceof HTMLAudioElement
				) {
					changed = this.unregisterMediaElement(current) || changed;
				}

				if (current instanceof Element && current.shadowRoot) {
					visit(current.shadowRoot);
				}

				current = walker.nextNode();
			}
		};

		visit(node);
		return changed;
	}

	private registerMediaElement(element: HTMLMediaElement): boolean {
		if (this.media.has(element)) return false;
		this.media.add(element);
		this.registrationOrder.set(element, this.registryOrderCounter++);

		const onMediaInteraction = () => {
			const now = performance.now();
			this.lastUserInteractionAt = now;
			this.mediaInteractionAt.set(element, now);
			this.activeMedia = this.resolveTargetMedia(element);
			this.emitState();
		};

		const onLoadedMetadata = () => {
			this.markLifecycleWindow(element);
			this.resolveTargetMedia(element);
			this.emitState();
		};

		const onCanPlay = () => {
			this.handleLifecycleReady(element);
		};

		const onPlaying = () => {
			this.handleLifecycleReady(element);
		};

		const onRateChange = () => {
			const expectedProgrammaticSpeed =
				this.expectedProgrammaticSpeeds.get(element);
			if (typeof expectedProgrammaticSpeed === "number") {
				const observedSpeed = this.getObservedPlaybackRate(element);
				if (
					observedSpeed !== null &&
					isApproximatelyEqual(
						observedSpeed,
						expectedProgrammaticSpeed,
						MediaRegistry.SPEED_EPSILON,
					)
				) {
					this.expectedProgrammaticSpeeds.delete(element);
					this.emitState();
					return;
				}

				this.expectedProgrammaticSpeeds.delete(element);
			}

			const target = this.resolveTargetMedia(element);
			if (target !== element) {
				this.emitState();
				return;
			}

			const settings = this.options.getSettings();
			if (!settings.enabled) {
				this.emitState();
				return;
			}

			const observedSpeed = this.getObservedPlaybackRate(element);
			if (observedSpeed === null) {
				if (
					this.shouldMaintainDesiredSpeed(element) &&
					!this.isWithinLifecycleRestoreWindow(element)
				) {
					this.enforceDesiredSpeed(element);
				}
				this.emitState();
				return;
			}

			if (this.isWithinLifecycleRestoreWindow(element)) {
				if (
					this.shouldMaintainDesiredSpeed(element) &&
					!isApproximatelyEqual(
						observedSpeed,
						this.getDesiredSpeed(),
						MediaRegistry.SPEED_EPSILON,
					)
				) {
					this.enforceDesiredSpeed(element);
				}
				this.emitState();
				return;
			}

			if (this.isLikelyManualRateChange(element)) {
				this.scheduleExternalSpeedAdoption(element);
				this.emitState();
				return;
			}

			if (this.shouldMaintainDesiredSpeed(element)) {
				const desiredSpeed = this.getDesiredSpeed();
				if (
					!isApproximatelyEqual(
						observedSpeed,
						desiredSpeed,
						MediaRegistry.SPEED_EPSILON,
					)
				) {
					this.enforceDesiredSpeed(element);
				}
			}
			this.emitState();
		};

		const listeners: ListenerBundle = {
			onMediaInteraction,
			onLoadedMetadata,
			onCanPlay,
			onPlaying,
			onRateChange,
		};

		element.addEventListener("pointerdown", onMediaInteraction, true);
		element.addEventListener("focus", onMediaInteraction, true);
		element.addEventListener("loadedmetadata", onLoadedMetadata, true);
		element.addEventListener("canplay", onCanPlay, true);
		element.addEventListener("playing", onPlaying, true);
		element.addEventListener("ratechange", onRateChange, true);
		this.listeners.set(element, listeners);

		if (element.readyState > 0 || !element.paused) {
			queueMicrotask(() => {
				if (!this.media.has(element)) return;
				this.markLifecycleWindow(element);
				if (
					element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
					!element.paused
				) {
					this.handleLifecycleReady(element);
				} else {
					this.emitState();
				}
			});
		}

		return true;
	}

	private unregisterMediaElement(element: HTMLMediaElement): boolean {
		if (!this.media.has(element)) return false;
		this.cancelPendingAdoption(element);
		this.detachListeners(element);
		this.media.delete(element);
		if (this.activeMedia === element) {
			this.activeMedia = null;
		}
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
		element.removeEventListener(
			"loadedmetadata",
			listeners.onLoadedMetadata,
			true,
		);
		element.removeEventListener("canplay", listeners.onCanPlay, true);
		element.removeEventListener("playing", listeners.onPlaying, true);
		element.removeEventListener("ratechange", listeners.onRateChange, true);
		this.listeners.delete(element);
	}
}
