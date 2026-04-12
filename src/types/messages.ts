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

export type ContentRequestMessage =
  | GetStateMessage
  | ApplyActionMessage
  | ApplyExactSpeedMessage;

export type RuntimeMessage = ContentRequestMessage | StateSnapshotMessage;
