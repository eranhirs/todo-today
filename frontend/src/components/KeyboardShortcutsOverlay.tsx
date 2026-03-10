interface Props {
  onClose: () => void;
}

const SHORTCUTS: { key: string; description: string }[] = [
  { key: "?", description: "Show / hide this overlay" },
  { key: "n", description: "Focus the new todo input" },
  { key: "j / ↓", description: "Move focus down" },
  { key: "k / ↑", description: "Move focus up" },
  { key: "1", description: "Set status: Up Next" },
  { key: "2", description: "Set status: In Progress" },
  { key: "3", description: "Set status: Completed" },
  { key: "4", description: "Set status: Consider" },
  { key: "5", description: "Set status: Waiting" },
  { key: "e", description: "Edit focused todo" },
  { key: "x", description: "Delete focused todo" },
  { key: "r", description: "Run focused todo with Claude" },
  { key: "Esc", description: "Clear focus / close overlay" },
  { key: "Cmd+Enter", description: "Submit new todo (while typing)" },
];

export function KeyboardShortcutsOverlay({ onClose }: Props) {
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <h3>Keyboard Shortcuts</h3>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="shortcut-row">
              <kbd className="shortcut-key">{s.key}</kbd>
              <span className="shortcut-desc">{s.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
