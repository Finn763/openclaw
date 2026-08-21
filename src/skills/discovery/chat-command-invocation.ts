// Chat command invocation helpers execute skill-provided chat command handlers.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { getChatCommands } from "../../auto-reply/commands-registry.data.js";
import type { SkillCommandSpec } from "../types.js";

/** Lists slash command names reserved by built-in chat commands and callers. */
export function listReservedChatSlashCommandNames(extraNames: string[] = []): Set<string> {
  const reserved = new Set<string>();
  for (const command of getChatCommands()) {
    if (command.nativeName) {
      reserved.add(normalizeOptionalLowercaseString(command.nativeName) ?? "");
    }
    for (const alias of command.textAliases) {
      const trimmed = alias.trim();
      if (!trimmed.startsWith("/")) {
        continue;
      }
      reserved.add(normalizeLowercaseStringOrEmpty(trimmed.slice(1)));
    }
  }
  for (const name of extraNames) {
    const trimmed = normalizeOptionalLowercaseString(name);
    if (trimmed) {
      reserved.add(trimmed);
    }
  }
  return reserved;
}

// Skill commands allow spaces/underscores in names but compare through dash-normalized lookup.
function normalizeSkillCommandLookup(value: string): string {
  return (normalizeOptionalLowercaseString(value) ?? "").replace(/[\s_]+/g, "-");
}

function findSkillCommand(
  skillCommands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeOptionalLowercaseString(trimmed) ?? "";
  const normalized = normalizeSkillCommandLookup(trimmed);
  return skillCommands.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.name) === lowered) {
      return true;
    }
    if (normalizeOptionalLowercaseString(entry.skillName) === lowered) {
      return true;
    }
    return (
      normalizeSkillCommandLookup(entry.name) === normalized ||
      normalizeSkillCommandLookup(entry.skillName) === normalized
    );
  });
}

function skillReferenceMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/\$([-a-zA-Z0-9_:]+)/gu);
}

function isEscapedReference(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isShellVariableReference(name: string): boolean {
  return !/[a-z]/u.test(name);
}

/** Returns true when text may contain an explicit `$skill-name` reference. */
export function hasSkillReferenceCandidate(text: string): boolean {
  for (const match of skillReferenceMatches(text)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (
      name &&
      index !== undefined &&
      !isEscapedReference(text, index) &&
      !isShellVariableReference(name)
    ) {
      return true;
    }
  }
  return false;
}

/** Resolves explicit `$skill-name` references against the current eligible skill commands. */
export function resolveSkillReferenceInvocations(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
}): SkillCommandSpec[] {
  const resolved: SkillCommandSpec[] = [];
  const seen = new Set<string>();
  for (const match of skillReferenceMatches(params.text)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (
      !name ||
      index === undefined ||
      isEscapedReference(params.text, index) ||
      isShellVariableReference(name)
    ) {
      continue;
    }
    const command = findSkillCommand(params.skillCommands, name);
    if (!command || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    resolved.push(command);
  }
  return resolved;
}

function cleanInlineSkillInvocation(body: string, start: number, end: number): string {
  return `${body.slice(0, start)} ${body.slice(end)}`.replace(/[^\S\r\n]+/gu, " ").trim();
}

export function resolveInlineSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string; inline: true } | null {
  const body = params.commandBodyNormalized;
  const directPattern = /(?:^|\s)\/([^\s:]+)\s*:\s*/giu;
  for (const match of body.matchAll(directPattern)) {
    const rawName = match[1] ?? "";
    if (normalizeOptionalLowercaseString(rawName) === "skill") {
      continue;
    }
    const command = findSkillCommand(params.skillCommands, rawName);
    if (!command || command.modelVisible === false || match.index === undefined) {
      continue;
    }
    const leadingWhitespace = match[0].length - match[0].trimStart().length;
    const start = match.index + leadingWhitespace;
    const end = match.index + match[0].length;
    const args = cleanInlineSkillInvocation(body, start, end);
    return { command, args: args || undefined, inline: true };
  }

  const skillPattern = /(?:^|\s)\/skill\s*:\s*([^\s:]+)/giu;
  for (const match of body.matchAll(skillPattern)) {
    const command = findSkillCommand(params.skillCommands, match[1] ?? "");
    if (!command || command.modelVisible === false || match.index === undefined) {
      continue;
    }
    const leadingWhitespace = match[0].length - match[0].trimStart().length;
    const start = match.index + leadingWhitespace;
    const end = match.index + match[0].length;
    const args = cleanInlineSkillInvocation(body, start, end);
    return { command, args: args || undefined, inline: true };
  }
  return null;
}

export function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string; inline?: boolean } | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (trimmed.startsWith("/")) {
    const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match) {
      return null;
    }
    const commandName = normalizeOptionalLowercaseString(match[1]);
    if (!commandName) {
      return null;
    }
    if (commandName === "skill") {
      const remainder = match[2]?.trim();
      if (!remainder) {
        return null;
      }
      const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!skillMatch) {
        return null;
      }
      const skillCommand = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
      if (!skillCommand) {
        return null;
      }
      const args = skillMatch[2]?.trim();
      return { command: skillCommand, args: args || undefined };
    }
    const command = params.skillCommands.find(
      (entry) => normalizeOptionalLowercaseString(entry.name) === commandName,
    );
    if (command) {
      const args = match[2]?.trim();
      return { command, args: args || undefined };
    }
  }
  return null;
}
