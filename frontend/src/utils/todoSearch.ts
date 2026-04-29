import type { Todo } from "../types";

/**
 * Extract all todo IDs referenced via `@[title](todo_id)` mentions in a piece of text.
 * Deduplicates within a single text.
 */
export function parseMentionIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  const re = /@\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * Build a reverse map of referenced_id → list of todos that mention that id.
 * Scans every todo's text for `@[...](id)` references.
 */
export function buildReferencedByMap(todos: Todo[]): Map<string, Todo[]> {
  const map = new Map<string, Todo[]>();
  for (const t of todos) {
    for (const refId of parseMentionIds(t.text)) {
      if (refId === t.id) continue;
      const list = map.get(refId);
      if (list) list.push(t);
      else map.set(refId, [t]);
    }
  }
  return map;
}

/** Case-insensitive search across todo text and run_output. */
export function matchesTodo(todo: Todo, query: string): boolean {
  const q = query.toLowerCase();
  return (
    todo.text.toLowerCase().includes(q) ||
    (todo.run_output != null && todo.run_output.toLowerCase().includes(q))
  );
}

/**
 * Sort todos for mention suggestions: running/done first, then by created_at descending.
 * Returns a new sorted array (does not mutate).
 */
const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  done: 1,
  stopped: 2,
  error: 3,
  queued: 4,
};

export function sortForMentions(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.run_status ?? ""] ?? 5;
    const pb = STATUS_PRIORITY[b.run_status ?? ""] ?? 5;
    if (pa !== pb) return pa - pb;
    return b.created_at.localeCompare(a.created_at);
  });
}

/**
 * Filter and sort todos for @ mention suggestions.
 * Reuses matchesTodo for search and sortForMentions for ordering.
 */
export function filterMentionSuggestions(
  allTodos: Todo[],
  query: string,
  excludeId?: string,
  limit = 10
): Todo[] {
  let matches = allTodos.filter(
    (t) => t.run_output && (!excludeId || t.id !== excludeId)
  );
  if (query) {
    matches = matches.filter((t) => matchesTodo(t, query));
  }
  return sortForMentions(matches).slice(0, limit);
}

/**
 * Filter and sort todos for the parent picker. Unlike @ mentions, this does
 * not require run_output — a manually-set parent can be any todo, including
 * manual/unrun ones — and defaults to scoping by projectId.
 */
export function filterParentSuggestions(
  allTodos: Todo[],
  query: string,
  excludeId: string,
  projectId?: string,
  limit = 10
): Todo[] {
  let matches = allTodos.filter(
    (t) => t.id !== excludeId && (!projectId || t.project_id === projectId)
  );
  if (query) {
    matches = matches.filter((t) => matchesTodo(t, query));
  }
  return sortForMentions(matches).slice(0, limit);
}
