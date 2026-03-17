/**
 * Slash-command parsing utilities for todo text.
 * Commands are /word tokens (e.g. "Fix the deploy /manual").
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

/** @deprecated Use BUILTIN_COMMANDS — kept for backward compat in stripCommandsFromText */
export const COMMANDS = BUILTIN_COMMANDS;

const COMMAND_RE = /(?:^|\s)(\/([A-Za-z][A-Za-z0-9_-]*))(?=\s|$)/g;

/**
 * Build a set of known command names for stripping.
 * Accepts an optional full list; falls back to builtins.
 */
function knownNames(allCommands?: CommandInfo[]): Set<string> {
  return new Set((allCommands ?? BUILTIN_COMMANDS).map((c) => c.name));
}

/** Parse recognized commands from text, returning deduplicated list. */
export function parseCommands(text: string, allCommands?: CommandInfo[]): string[] {
  const names = knownNames(allCommands);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(COMMAND_RE)) {
    const cmd = m[2].toLowerCase();
    if (names.has(cmd) && !seen.has(cmd)) {
      seen.add(cmd);
      result.push(cmd);
    }
  }
  return result;
}

/** Remove recognized /command tokens from text for display purposes. */
export function stripCommandsFromText(text: string, allCommands?: CommandInfo[]): string {
  const names = knownNames(allCommands);
  return text
    .replace(COMMAND_RE, (match, _full, cmd) =>
      names.has(cmd.toLowerCase()) ? "" : match
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}
