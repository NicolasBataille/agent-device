// Enumerates every dynamic value that reaches a device shell. `adb shell`,
// `adb exec-out`, and `hdc shell` join their argv into ONE string that the
// device's `sh` evaluates, so any non-literal element is a potential argv
// injection unless it is quoted (utils/shell-quote) or validated upstream.
// The repo's own audit found exactly this class of bug on `input text` and
// `cmd clipboard set text` (both now quote through `shellQuoteIfNeeded`), and
// nothing else enumerated "args reaching a device shell" — a new call site
// could regress it silently.
//
// This gate is an inventory, not a per-site approval spray: every dynamic
// element is recorded in scripts/shell-argv/inventory.json keyed by
// (file, expression text) with a count. A new or grown entry fails the check
// until the author either quotes the value or updates the inventory in the
// same PR — making "a new value now reaches the device shell" a visible,
// reviewable diff instead of a silent change. A shrunken entry fails too, so
// the inventory can only ever track the code exactly (the same two-sided
// strictness as scripts/di-seams and the test-file size ratchet).
//
// Detection is AST-based (`oxc-parser`, the same tool scripts/layering and
// scripts/di-seams use): an ArrayExpression whose first element is the string
// literal 'shell' or 'exec-out' is a device-shell argv. Statically safe
// elements — string/number literals, expression-free templates, calls to
// `shellQuote`/`shellQuoteIfNeeded`, and compositions of those — are not
// inventoried. Everything else is. The heuristic deliberately keys on the
// direct argv shape; an argv assembled through mutation or a variable is
// outside its reach and belongs in review.

import { parseSync } from 'oxc-parser';

export type SourceFile = {
  readonly path: string;
  readonly source: string;
};

export type ShellArgvValue = {
  readonly file: string;
  readonly line: number;
  /** Whitespace-collapsed source text of the unsafe expression. */
  readonly expression: string;
};

type AstNode = Record<string, unknown>;

const DEVICE_SHELL_SUBCOMMANDS = new Set(['shell', 'exec-out']);
const QUOTE_FUNCTION_NAMES = new Set(['shellQuote', 'shellQuoteIfNeeded']);

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** A string the element is statically known to be: a literal, or an expression-free template. */
function staticStringValue(node: AstNode | null): string | null {
  if (!node) return null;
  if (node['type'] === 'Literal' && typeof node['value'] === 'string') {
    return node['value'] as string;
  }
  if (
    node['type'] === 'TemplateLiteral' &&
    ((node['expressions'] as unknown[]) ?? []).length === 0
  ) {
    const quasis = (node['quasis'] as AstNode[]) ?? [];
    const cooked = (quasis[0]?.['value'] as AstNode | undefined)?.['cooked'];
    return quasis.length === 1 && typeof cooked === 'string' ? cooked : null;
  }
  return null;
}

function calleeName(node: AstNode): string | null {
  const callee = node['callee'] as AstNode | undefined;
  if (callee?.['type'] === 'Identifier') return callee['name'] as string;
  if (callee?.['type'] === 'MemberExpression') {
    const property = callee['property'] as AstNode | undefined;
    if (property?.['type'] === 'Identifier') return property['name'] as string;
  }
  return null;
}

/**
 * Walks one argv element and collects its innermost statically-unsafe
 * expressions. Compositions of safe parts (templates, `+`, ternaries, spreads
 * of array literals) recurse so `...(flag ? ['-m', module] : [])` inventories
 * `module`, not the whole spread.
 */
function collectUnsafe(node: AstNode | null, source: string, file: string, out: ShellArgvValue[]) {
  if (!node || typeof node !== 'object') return;
  switch (node['type']) {
    case 'Literal':
      return;
    case 'TemplateLiteral': {
      for (const expression of (node['expressions'] as AstNode[]) ?? []) {
        collectUnsafe(expression, source, file, out);
      }
      return;
    }
    case 'CallExpression': {
      const name = calleeName(node);
      if (name !== null && QUOTE_FUNCTION_NAMES.has(name)) return;
      break;
    }
    case 'BinaryExpression': {
      if (node['operator'] === '+') {
        collectUnsafe(node['left'] as AstNode, source, file, out);
        collectUnsafe(node['right'] as AstNode, source, file, out);
        return;
      }
      break;
    }
    case 'ConditionalExpression': {
      collectUnsafe(node['consequent'] as AstNode, source, file, out);
      collectUnsafe(node['alternate'] as AstNode, source, file, out);
      return;
    }
    case 'SpreadElement': {
      collectUnsafe(node['argument'] as AstNode, source, file, out);
      return;
    }
    case 'ParenthesizedExpression': {
      collectUnsafe(node['expression'] as AstNode, source, file, out);
      return;
    }
    case 'ArrayExpression': {
      for (const element of (node['elements'] as (AstNode | null)[]) ?? []) {
        collectUnsafe(element, source, file, out);
      }
      return;
    }
    default:
      break;
  }
  const start = node['start'] as number;
  const end = node['end'] as number;
  out.push({
    file,
    line: lineOf(source, start),
    expression: source.slice(start, end).replace(/\s+/g, ' ').trim(),
  });
}

export function findShellArgvValues(files: readonly SourceFile[]): ShellArgvValue[] {
  const values: ShellArgvValue[] = [];
  for (const { path: file, source } of files) {
    if (!source.includes("'shell'") && !source.includes("'exec-out'")) continue;
    const parsed = parseSync(file, source);
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as AstNode;
      if (record['type'] === 'ArrayExpression') {
        const elements = (record['elements'] as (AstNode | null)[]) ?? [];
        const subcommand = staticStringValue(elements[0] ?? null);
        if (subcommand !== null && DEVICE_SHELL_SUBCOMMANDS.has(subcommand)) {
          for (const element of elements.slice(1)) {
            collectUnsafe(element, source, file, values);
          }
        }
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(parsed.program);
  }
  return values;
}

/** Inventory shape: `<file> :: <expression>` → occurrence count, sorted by key. */
export function toInventory(values: readonly ShellArgvValue[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = `${value.file} :: ${value.expression}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export type InventoryDiff = {
  /** Keys present (or grown) in the scan but not (fully) in the inventory. */
  readonly added: readonly string[];
  /** Keys present (or larger) in the inventory but not (fully) in the scan. */
  readonly stale: readonly string[];
};

export function diffInventory(
  scanned: Readonly<Record<string, number>>,
  recorded: Readonly<Record<string, number>>,
): InventoryDiff {
  const added: string[] = [];
  const stale: string[] = [];
  for (const [key, count] of Object.entries(scanned)) {
    const known = recorded[key] ?? 0;
    if (count > known) added.push(`${key} (${count} site(s), ${known} recorded)`);
  }
  for (const [key, count] of Object.entries(recorded)) {
    const live = scanned[key] ?? 0;
    if (count > live) stale.push(`${key} (${count} recorded, ${live} site(s))`);
  }
  return { added: added.sort(), stale: stale.sort() };
}
