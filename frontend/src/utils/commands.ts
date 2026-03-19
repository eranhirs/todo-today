/**
 * Slash-command parsing utilities for todo text.
 * Commands are /word tokens (e.g. "Fix the deploy /commit").
 *
 * Any /word is treated as a command — it will be proxied to Claude CLI.
 * Only /manual has special behavior (noop). The autocomplete dropdown
 * shows commands discovered from the API, but any /word is accepted.
 */

export interface CommandInfo {
  name: string;
  description: string;
  type: "command" | "skill";
}

/** Built-in slash commands (always available, before API fetch). */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "manual", description: "Human-only task — cannot be run by Claude", type: "command" },
];

/** @deprecated Use BUILTIN_COMMANDS — kept for backward compat */
export const COMMANDS = BUILTIN_COMMANDS;

const COMMAND_RE = /(?:^|\s)(\/([A-Za-z][A-Za-z0-9_-]*))(?=\s|$)/g;

/** Parse all /command tokens from text, returning deduplicated list. */
export function parseCommands(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(COMMAND_RE)) {
    const cmd = m[2].toLowerCase();
    if (!seen.has(cmd)) {
      seen.add(cmd);
      result.push(cmd);
    }
  }
  return result;
}

/** Remove all /command tokens from text for display purposes. */
export function stripCommandsFromText(text: string): string {
  return text
    .replace(COMMAND_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
