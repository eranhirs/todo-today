import type { Todo } from "../types";

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
