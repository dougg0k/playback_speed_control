import type { ShortcutConfig, ShortcutAction } from "@/types/settings";

const LABELS: Record<ShortcutAction, string> = {
  increase: "Increase speed",
  decrease: "Decrease speed",
  reset: "Reset to 1x",
  preferred: "Apply preferred speed",
};

interface ShortcutEditorProps {
  shortcuts: ShortcutConfig;
  onChange: (nextShortcuts: ShortcutConfig) => void;
}

export function ShortcutEditor({ shortcuts, onChange }: ShortcutEditorProps) {
  return (
    <div className="settings-group">
      <div className="section-heading">
        <h3>Shortcuts</h3>
        <span>Default speed keys are d and s. Single-key shortcuts work when page focus is not in an input.</span>
      </div>

      <div className="shortcut-list">
        {(Object.keys(shortcuts) as ShortcutAction[]).map((action) => (
          <label className="field" key={action}>
            <span>{LABELS[action]}</span>
            <input
              type="text"
              value={shortcuts[action]}
              placeholder={action === "increase" ? "d" : action === "decrease" ? "s" : "Alt+Shift+0"}
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
    </div>
  );
}
