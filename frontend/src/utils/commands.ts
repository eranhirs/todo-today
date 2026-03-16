/**
 * Slash-command parsing utilities for todo text.
 * Commands are /word tokens (e.g. "Fix the deploy /manual").
 */

/** All recognized slash commands with descriptions. */
export const COMMANDS: { name: string; description: string }[] = [
  { name: "manual", description: "Human-only task — cannot be run by Claude" },
];

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

const COMMAND_RE = /(?:^|\s)(\/([A-Za-z][A-Za-z0-9_-]*))(?=\s|$)/g;

/** Parse recognized commands from text, returning deduplicated list. */
export function parseCommands(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(COMMAND_RE)) {
    const cmd = m[2].toLowerCase();
    if (COMMAND_NAMES.has(cmd) && !seen.has(cmd)) {
      seen.add(cmd);
      result.push(cmd);
    }
  }
  return result;
}

/** Remove recognized /command tokens from text for display purposes. */
export function stripCommandsFromText(text: string): string {
  return text
    .replace(COMMAND_RE, (match, _full, cmd) =>
      COMMAND_NAMES.has(cmd.toLowerCase()) ? "" : match
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}
