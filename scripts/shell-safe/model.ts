// Backstop for the typed device-shell boundary. `ShellSafe` (packages/kernel/
// src/shell-safe.ts) makes a raw string unable to reach a device shell — but
// TypeScript's nominal typing can always be defeated by an assertion, and the
// `sh.raw()` constructor is a deliberate escape hatch for author-written shell
// fragments. This gate holds both to an approved set, the same shape as
// scripts/di-seams: an AST match must carry a `// shell-safe-approved: <reason>`
// comment on the immediately-preceding line, or the gate fails.
//
// Two things are matched in production source:
//   - `sh.raw(...)` calls (the escape hatch): every use must be justified.
//   - `as ShellSafe` / `as unknown as ShellSafe` casts: a hole in the brand.
//     These are legitimate ONLY inside the constructors in shell-safe.ts, which
//     the check exempts by path; anywhere else they need approval.

import { parseSync } from 'oxc-parser';

const APPROVAL_MARKER = 'shell-safe-approved:';

export type SourceFile = {
  readonly path: string;
  readonly source: string;
};

export type ShellSafeMatch = {
  readonly file: string;
  readonly line: number;
  readonly kind: 'sh.raw' | 'as-shell-safe';
  readonly text: string;
  readonly approved: boolean;
};

type AstNode = Record<string, unknown>;
type Comment = { readonly value: string; readonly start: number; readonly end: number };

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/**
 * True when a `shell-safe-approved: <reason>` comment sits on a line at or just
 * above the match's line — the same "marker precedes what it exempts" shape as
 * scripts/di-seams, but line-anchored so an approval directly above a statement
 * covers a `sh.raw(...)` nested inside that statement (`const x = sh.raw(...)`).
 */
function isApproved(source: string, comments: readonly Comment[], start: number): boolean {
  const matchLine = lineOf(source, start);
  for (const comment of comments) {
    if (comment.end > start) continue;
    const commentLine = lineOf(source, comment.end);
    if (commentLine !== matchLine && commentLine !== matchLine - 1) continue;
    const value = comment.value.trim();
    if (value.startsWith(APPROVAL_MARKER)) {
      return value.slice(APPROVAL_MARKER.length).trim().length > 0;
    }
  }
  return false;
}

function isShRaw(node: AstNode): boolean {
  if (node['type'] !== 'CallExpression') return false;
  const callee = node['callee'] as AstNode | undefined;
  if (callee?.['type'] !== 'MemberExpression') return false;
  const object = callee['object'] as AstNode | undefined;
  const property = callee['property'] as AstNode | undefined;
  return (
    object?.['type'] === 'Identifier' &&
    object['name'] === 'sh' &&
    property?.['type'] === 'Identifier' &&
    property['name'] === 'raw'
  );
}

function isShellSafeCast(node: AstNode): boolean {
  if (node['type'] !== 'TSAsExpression') return false;
  const annotation = node['typeAnnotation'] as AstNode | undefined;
  return (
    annotation?.['type'] === 'TSTypeReference' &&
    (annotation['typeName'] as AstNode | undefined)?.['type'] === 'Identifier' &&
    (annotation['typeName'] as AstNode)['name'] === 'ShellSafe'
  );
}

/** Path whose `as ShellSafe` casts are the sanctioned constructors, not holes. */
function isBrandConstructorModule(file: string): boolean {
  return file.endsWith('packages/kernel/src/shell-safe.ts') || file.endsWith('kernel/src/shell-safe.ts');
}

export function findShellSafeMatches(files: readonly SourceFile[]): ShellSafeMatch[] {
  const matches: ShellSafeMatch[] = [];
  for (const { path: file, source } of files) {
    if (!source.includes('sh.raw') && !source.includes('as ShellSafe')) continue;
    const parsed = parseSync(file, source);
    const comments = parsed.comments as readonly Comment[];
    const constructorModule = isBrandConstructorModule(file);
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as AstNode;
      const kind = isShRaw(record)
        ? ('sh.raw' as const)
        : isShellSafeCast(record) && !constructorModule
          ? ('as-shell-safe' as const)
          : undefined;
      if (kind) {
        const start = record['start'] as number;
        matches.push({
          file,
          line: lineOf(source, start),
          kind,
          text: source
            .slice(start, record['end'] as number)
            .replace(/\s+/g, ' ')
            .slice(0, 100),
          approved: isApproved(source, comments, start),
        });
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(parsed.program);
  }
  return matches;
}

export function unapprovedShellSafeMatches(
  matches: readonly ShellSafeMatch[],
): readonly ShellSafeMatch[] {
  return matches.filter((match) => !match.approved);
}
