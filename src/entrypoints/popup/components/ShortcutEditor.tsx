import { SHORTCUT_LABELS, SHORTCUT_PLACEHOLDERS } from "@/constants/extension";
import type { ShortcutAction, ShortcutConfig } from "@/types/settings";

interface ShortcutEditorProps {
	shortcuts: ShortcutConfig;
	onChange: (nextShortcuts: ShortcutConfig) => void;
}

export function ShortcutEditor({ shortcuts, onChange }: ShortcutEditorProps) {
	return (
		<div className="shortcut-list">
			{(Object.keys(shortcuts) as ShortcutAction[]).map((action) => (
				<label className="field" key={action}>
					<span>{SHORTCUT_LABELS[action]}</span>
					<input
						type="text"
						value={shortcuts[action]}
						placeholder={SHORTCUT_PLACEHOLDERS[action]}
						onChange={(event) =>
							onChange({
								...shortcuts,
								[action]: event.target.value,
							})
						}
					/>
				</label>
			))}
		</div>
	);
}
