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
  if (node === null) return null;
  if (node['type'] === 'Literal') {
    return typeof node['value'] === 'string' ? node['value'] : null;
  }
  if (node['type'] !== 'TemplateLiteral') return null;
  // oxc always materializes `expressions` and `quasis` on a TemplateLiteral.
  const quasis = node['quasis'] as AstNode[];
  if ((node['expressions'] as unknown[]).length > 0 || quasis.length !== 1) return null;
  const cooked = ((quasis[0] as AstNode)['value'] as AstNode)['cooked'];
  return typeof cooked === 'string' ? cooked : null;
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
 * Node types that are safe as compositions: recurse into the named fields so
 * `...(flag ? ['-m', module] : [])` inventories `module`, not the whole
 * spread. The ternary's test never reaches the shell, so it is not listed.
 */
const COMPOSITE_CHILD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  TemplateLiteral: ['expressions'],
  ConditionalExpression: ['consequent', 'alternate'],
  SpreadElement: ['argument'],
  ParenthesizedExpression: ['expression'],
  ArrayExpression: ['elements'],
};

function isSafeLeaf(node: AstNode): boolean {
  if (node['type'] === 'Literal') return true;
  return node['type'] === 'CallExpression' && QUOTE_FUNCTION_NAMES.has(calleeName(node) ?? '');
}

function compositeChildFields(node: AstNode): readonly string[] | undefined {
  if (node['type'] === 'BinaryExpression' && node['operator'] === '+') return ['left', 'right'];
  return COMPOSITE_CHILD_FIELDS[node['type'] as string];
}

/** Walks one argv element and collects its innermost statically-unsafe expressions. */
function collectUnsafe(node: AstNode | null, source: string, file: string, out: ShellArgvValue[]) {
  if (!node || typeof node !== 'object' || isSafeLeaf(node)) return;
  const childFields = compositeChildFields(node);
  if (childFields === undefined) {
    const start = node['start'] as number;
    out.push({
      file,
      line: lineOf(source, start),
      expression: source
        .slice(start, node['end'] as number)
        .replace(/\s+/g, ' ')
        .trim(),
    });
    return;
  }
  for (const field of childFields) {
    const value = node[field];
    for (const child of Array.isArray(value) ? value : [value]) {
      collectUnsafe(child as AstNode | null, source, file, out);
    }
  }
}

/** The elements after the subcommand when `record` is a device-shell argv array, else empty. */
function deviceShellArgvElements(record: AstNode): readonly (AstNode | null)[] {
  if (record['type'] !== 'ArrayExpression') return [];
  const elements = (record['elements'] as (AstNode | null)[]) ?? [];
  const subcommand = staticStringValue(elements[0] ?? null);
  if (subcommand === null || !DEVICE_SHELL_SUBCOMMANDS.has(subcommand)) return [];
  return elements.slice(1);
}

export function findShellArgvValues(files: readonly SourceFile[]): ShellArgvValue[] {
  const values: ShellArgvValue[] = [];
  for (const { path: file, source } of files) {
    if (!source.includes("'shell'") && !source.includes("'exec-out'")) continue;
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as AstNode;
      for (const element of deviceShellArgvElements(record)) {
        collectUnsafe(element, source, file, values);
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(parseSync(file, source).program);
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
