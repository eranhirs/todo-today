/**
 * Tag parsing utilities — mirrors backend/tags.py logic.
 * Tags are #word tokens in todo text (e.g. "Fix bug #backend #urgent").
 */

const TAG_RE = /(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_-]*)/g;

/** Extract tags from text, returning lowercase deduplicated list. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

/** Remove #tag tokens from text for display purposes. */
export function stripTagsFromText(text: string): string {
  return text.replace(TAG_RE, "").replace(/\s{2,}/g, " ").trim();
}
