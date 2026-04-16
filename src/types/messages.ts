import { MESSAGE_TYPES } from "@/constants/extension";
import type { ShortcutAction } from "./settings";

export interface PopupState {
	hasMedia: boolean;
	activeKind: "video" | "audio" | null;
	currentSpeed: number | null;
	siteDisabled: boolean;
	hostname: string;
	mediaCount: number;
}

export interface StateSnapshotMessage {
	type: typeof MESSAGE_TYPES.stateSnapshot;
	payload: PopupState;
}

export interface GetStateMessage {
	type: typeof MESSAGE_TYPES.getState;
}

export interface ApplyActionMessage {
	type: typeof MESSAGE_TYPES.applyAction;
	payload: {
		action: ShortcutAction;
	};
}

export interface ApplyExactSpeedMessage {
	type: typeof MESSAGE_TYPES.applyExactSpeed;
	payload: {
		speed: number;
	};
}

export interface GetTabStateMessage {
	type: typeof MESSAGE_TYPES.getTabState;
	payload: {
		tabId: number;
	};
}

export interface ApplyTabActionMessage {
	type: typeof MESSAGE_TYPES.applyTabAction;
	payload: {
		tabId: number;
		action: ShortcutAction;
	};
}

export interface ApplyTabExactSpeedMessage {
	type: typeof MESSAGE_TYPES.applyTabExactSpeed;
	payload: {
		tabId: number;
		speed: number;
	};
}

export interface TabStateResponse {
	state: PopupState | null;
}

export interface TabStateChangedMessage {
	type: typeof MESSAGE_TYPES.tabStateChanged;
	payload: {
		tabId: number;
		state: PopupState | null;
	};
}

export type ContentRequestMessage =
	| GetStateMessage
	| ApplyActionMessage
	| ApplyExactSpeedMessage;

export type RuntimeMessage =
	| StateSnapshotMessage
	| GetTabStateMessage
	| ApplyTabActionMessage
	| ApplyTabExactSpeedMessage
	| TabStateChangedMessage;
