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

/**
 * Build a forward map of todo_id → list of todos that this todo mentions.
 * Mirror of buildReferencedByMap so the UI can surface outgoing references too.
 * Mentions whose target id is not in `todos` (e.g. paginated away or deleted)
 * are skipped.
 */
export function buildReferencesMap(todos: Todo[]): Map<string, Todo[]> {
  const byId = new Map<string, Todo>();
  for (const t of todos) byId.set(t.id, t);
  const map = new Map<string, Todo[]>();
  for (const t of todos) {
    const refs: Todo[] = [];
    for (const refId of parseMentionIds(t.text)) {
      if (refId === t.id) continue;
      const target = byId.get(refId);
      if (target) refs.push(target);
    }
    if (refs.length > 0) map.set(t.id, refs);
  }
  return map;
}

/**
 * Relaxed case-insensitive search across todo text and run_output. The query
 * is split on whitespace and every token must appear as a substring in either
 * field — so "debug tree" matches "debug the decision tree".
 */
export function matchesTodo(todo: Todo, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = todo.text.toLowerCase();
  const output = todo.run_output != null ? todo.run_output.toLowerCase() : "";
  return tokens.every((tok) => text.includes(tok) || output.includes(tok));
}

/**
 * Rank how well a todo matches a query, lower is better. Used to order mention
 * suggestions so exact phrase matches come before fuzzy multi-token matches.
 *   0 — exact phrase appears in the title
 *   1 — all tokens appear in title in the order typed (e.g. "debug … tree")
 *   2 — all tokens appear in title in any order
 *   3 — match relies on run_output (last resort)
 *   4 — no token-level match (shouldn't normally reach sort)
 */
function matchScore(todo: Todo, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const text = todo.text.toLowerCase();
  if (text.includes(q)) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    let cursor = 0;
    let inOrder = true;
    for (const tok of tokens) {
      const idx = text.indexOf(tok, cursor);
      if (idx === -1) {
        inOrder = false;
        break;
      }
      cursor = idx + tok.length;
    }
    if (inOrder) return 1;
  }
  if (tokens.every((tok) => text.includes(tok))) return 2;
  const output = todo.run_output != null ? todo.run_output.toLowerCase() : "";
  if (output && tokens.every((tok) => text.includes(tok) || output.includes(tok))) return 3;
  return 4;
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
 * Sort by query relevance first (exact > in-order > any-order > run_output),
 * then fall back to the standard mention ordering. With no query, behaves
 * exactly like sortForMentions.
 */
function sortForMentionsByQuery(todos: Todo[], query: string): Todo[] {
  const q = query.trim();
  if (!q) return sortForMentions(todos);
  const ranked = sortForMentions(todos);
  return [...ranked].sort((a, b) => matchScore(a, q) - matchScore(b, q));
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
  return sortForMentionsByQuery(matches, query).slice(0, limit);
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
  return sortForMentionsByQuery(matches, query).slice(0, limit);
}
