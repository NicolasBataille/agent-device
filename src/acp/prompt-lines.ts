import { listMcpExposedCommandNames } from '../core/command-descriptor/registry.ts';
import type { CliFlags } from '../cli/parser/cli-flags.ts';
import type { CommandName } from '../commands/command-metadata.ts';
import { tokenizeReplayLine } from '../replay/script.ts';
import { resolveCliOptions } from '../utils/cli-options.ts';
import { STICKY_FLAG_KEYS, type StickyFlags } from './session-state.ts';

export type RunnableLine = {
  kind: 'command';
  line: string;
  command: CommandName;
  positionals: string[];
  flags: CliFlags;
  providedSticky: StickyFlags;
};

export type UnrunnableLine = {
  kind: 'error';
  line: string;
  error: string;
};

export type PromptLine = RunnableLine | UnrunnableLine;

/**
 * Turn the text of an ACP prompt into agent-device command invocations: one
 * command per non-blank, non-comment line, in the CLI/replay-script dialect
 * (quote-aware tokens, optional leading `agent-device`). Sticky-flag merging
 * happens at execution time in the prompt runner, so flags set by an earlier
 * line of the same prompt reach later lines.
 */
export function parsePromptCommandLines(text: string, options: { cwd: string }): PromptLine[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => parsePromptCommandLine(line, options));
}

/**
 * Fill in target selection (`--platform`, `--session`, …) remembered from
 * earlier lines for the sticky keys this line did not restate. Explicit flags
 * always win.
 */
export function applyStickyFlags(line: RunnableLine, sticky: StickyFlags): CliFlags {
  const flags = { ...line.flags };
  for (const key of STICKY_FLAG_KEYS) {
    if (line.providedSticky[key] === undefined && sticky[key] !== undefined) {
      copyStickyFlag(flags, sticky, key);
    }
  }
  return flags;
}

function parsePromptCommandLine(line: string, options: { cwd: string }): PromptLine {
  let tokens: string[];
  try {
    tokens = tokenizeReplayLine(line);
  } catch (error) {
    return { kind: 'error', line, error: error instanceof Error ? error.message : String(error) };
  }
  if (tokens[0] === 'agent-device') tokens = tokens.slice(1);
  if (tokens.length === 0) {
    return { kind: 'error', line, error: 'Empty command line.' };
  }
  try {
    return finalizePromptCommandLine(line, tokens, options);
  } catch (error) {
    return { kind: 'error', line, error: error instanceof Error ? error.message : String(error) };
  }
}

function finalizePromptCommandLine(
  line: string,
  tokens: string[],
  options: { cwd: string },
): PromptLine {
  const parsed = resolveCliOptions(tokens, { cwd: options.cwd });
  const command = parsed.command;
  if (command === null || !isAcpRunnableCommand(command)) {
    return {
      kind: 'error',
      line,
      error: `Unknown command: ${command ?? tokens[0]}. Run one agent-device command per line (e.g. "devices", "snapshot -i", "press @e2").`,
    };
  }
  const providedKeys = new Set(parsed.providedFlags.map((entry) => entry.key));
  const flags = parsed.flags as CliFlags;
  const providedSticky: StickyFlags = {};
  for (const key of STICKY_FLAG_KEYS) {
    if (providedKeys.has(key)) copyStickyFlag(providedSticky, flags, key);
  }
  return {
    kind: 'command',
    line,
    command: command as CommandName,
    positionals: parsed.positionals,
    flags,
    providedSticky,
  };
}

// One generic assignment site so the per-key value types stay aligned between
// the two sticky-flag containers without per-key casts.
function copyStickyFlag<K extends keyof StickyFlags>(
  target: StickyFlags,
  source: StickyFlags,
  key: K,
): void {
  target[key] = source[key];
}

function isAcpRunnableCommand(command: string): boolean {
  return (listMcpExposedCommandNames() as readonly string[]).includes(command);
}
