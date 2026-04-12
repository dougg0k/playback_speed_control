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
	type: "PSC_STATE_SNAPSHOT";
	payload: PopupState;
}

export interface GetStateMessage {
	type: "PSC_GET_STATE";
}

export interface ApplyActionMessage {
	type: "PSC_APPLY_ACTION";
	payload: {
		action: ShortcutAction;
	};
}

export interface ApplyExactSpeedMessage {
	type: "PSC_APPLY_EXACT_SPEED";
	payload: {
		speed: number;
	};
}

export interface GetTabStateMessage {
	type: "PSC_GET_TAB_STATE";
	payload: {
		tabId: number;
	};
}

export interface ApplyTabActionMessage {
	type: "PSC_APPLY_TAB_ACTION";
	payload: {
		tabId: number;
		action: ShortcutAction;
	};
}

export interface ApplyTabExactSpeedMessage {
	type: "PSC_APPLY_TAB_EXACT_SPEED";
	payload: {
		tabId: number;
		speed: number;
	};
}

export interface TabStateResponse {
	state: PopupState | null;
}

export interface TabStateChangedMessage {
	type: "PSC_TAB_STATE_CHANGED";
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
