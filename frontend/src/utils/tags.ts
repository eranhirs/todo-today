/**
 * Tag parsing utilities — mirrors backend/tags.py logic.
 * Tags are #word tokens in todo text (e.g. "Fix bug #backend #urgent").
 * Priority keywords (#p1–#p4, #critical, #high, #medium, #low) are parsed
 * as priorities, NOT as regular tags.
 */

const TAG_RE = /(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_-]*)/g;

/** Priority keyword mapping: keyword -> priority level (1=critical, 4=low) */
export const PRIORITY_KEYWORDS: Record<string, number> = {
  p1: 1, critical: 1,
  p2: 2, high: 2,
  p3: 3, medium: 3,
  p4: 4, low: 4,
};

/** Priority level -> display info */
export const PRIORITY_INFO: Record<number, { label: string; short: string; color: string }> = {
  1: { label: "Critical", short: "P1", color: "#e53e3e" },
  2: { label: "High", short: "P2", color: "#dd6b20" },
  3: { label: "Medium", short: "P3", color: "#d69e2e" },
  4: { label: "Low", short: "P4", color: "#718096" },
};

/** Check if a tag name (without #) is a priority keyword. */
export function isPriorityKeyword(tag: string): boolean {
  return tag.toLowerCase() in PRIORITY_KEYWORDS;
}

/** Extract the highest priority from text. Returns null if none found. */
export function parsePriority(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    const level = PRIORITY_KEYWORDS[tag];
    if (level !== undefined && (best === null || level < best)) {
      best = level;
    }
  }
  return best;
}

/** Extract tags from text, returning lowercase deduplicated list. Excludes priority keywords. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (!seen.has(tag) && !(tag in PRIORITY_KEYWORDS)) {
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

/** Remove priority keyword tokens from text for display purposes. */
export function stripPriorityFromText(text: string): string {
  return text.replace(TAG_RE, (match, tag: string) => {
    return tag.toLowerCase() in PRIORITY_KEYWORDS ? "" : match;
  }).replace(/\s{2,}/g, " ").trim();
}
