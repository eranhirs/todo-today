const STORAGE_KEY = "section-collapse-state";

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Returns the persisted expanded state for a section, or the default if not set. */
export function getSectionExpanded(key: string, defaultValue: boolean): boolean {
  const state = load();
  return key in state ? state[key] : defaultValue;
}

/** Persists the expanded state for a section. */
export function setSectionExpanded(key: string, expanded: boolean): void {
  const state = load();
  state[key] = expanded;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
