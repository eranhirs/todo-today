const STORAGE_KEY = "project-display-names";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function getDisplayName(projectId: string): string | null {
  return load()[projectId] ?? null;
}

export function setDisplayName(projectId: string, name: string): void {
  const names = load();
  names[projectId] = name;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
}
