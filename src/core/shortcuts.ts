import type { ShortcutAction, ShortcutConfig } from "@/types/settings";

export interface NormalizedShortcut {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	key: string;
}

const SPECIAL_KEYS: Record<string, string> = {
	".": "period",
	",": "comma",
	" ": "space",
	escape: "escape",
	esc: "escape",
};

export function normalizeShortcutKey(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const special = SPECIAL_KEYS[trimmed.toLowerCase()];
	return special ?? trimmed.toLowerCase();
}

export function parseShortcut(input: string): NormalizedShortcut | null {
	const parts = input
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length === 0) return null;

	let altKey = false;
	let ctrlKey = false;
	let metaKey = false;
	let shiftKey = false;
	let key = "";

	for (const part of parts) {
		const lower = part.toLowerCase();

		if (["alt", "option"].includes(lower)) {
			altKey = true;
			continue;
		}

		if (["ctrl", "control"].includes(lower)) {
			ctrlKey = true;
			continue;
		}

		if (["meta", "cmd", "command"].includes(lower)) {
			metaKey = true;
			continue;
		}

		if (lower === "shift") {
			shiftKey = true;
			continue;
		}

		key = normalizeShortcutKey(part);
	}

	if (!key) return null;

	return { altKey, ctrlKey, metaKey, shiftKey, key };
}

export function matchesShortcut(
	event: KeyboardEvent,
	shortcut: string,
): boolean {
	const parsed = parseShortcut(shortcut);
	if (!parsed) return false;

	return (
		event.altKey === parsed.altKey &&
		event.ctrlKey === parsed.ctrlKey &&
		event.metaKey === parsed.metaKey &&
		event.shiftKey === parsed.shiftKey &&
		normalizeShortcutKey(event.key) === parsed.key
	);
}

export function matchShortcutAction(
	event: KeyboardEvent,
	shortcuts: ShortcutConfig,
): ShortcutAction | null {
	if (matchesShortcut(event, shortcuts.increase)) return "increase";
	if (matchesShortcut(event, shortcuts.decrease)) return "decrease";
	if (matchesShortcut(event, shortcuts.reset)) return "reset";
	if (matchesShortcut(event, shortcuts.preferred)) return "preferred";
	return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;

	const tagName = target.tagName.toLowerCase();
	return ["input", "textarea", "select"].includes(tagName);
}
