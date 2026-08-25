// `pnpm check:shell-argv` — fails when the set of dynamic values reaching a
// device shell (`adb shell` / `adb exec-out` / `hdc shell` argv) drifts from
// scripts/shell-argv/inventory.json in either direction. See model.ts for
// what counts as a dynamic value and why the gate is an inventory rather
// than a per-site approval marker.
//
// A NEW entry means a value now reaches the device shell that did not
// before: prefer quoting it with `shellQuoteIfNeeded` (utils/shell-quote) —
// free-form text must always be quoted — and only when the value is
// validated upstream (a number, an enum, a resolver-checked package name)
// record it with `pnpm check:shell-argv --update` so the reviewer sees the
// inventory grow in the same diff.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffInventory,
  findShellArgvValues,
  toInventory,
  type InventoryDiff,
  type SourceFile,
} from './model.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const inventoryPath = path.join(repoRoot, 'scripts', 'shell-argv', 'inventory.json');

function listProductionSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'src', 'packages'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter(
      (file) => file.endsWith('.ts') && !file.includes('/__tests__/') && !file.endsWith('.test.ts'),
    );
}

function readSources(files: readonly string[]): SourceFile[] {
  return files.map((file) => ({
    path: file,
    source: fs.readFileSync(path.join(repoRoot, file), 'utf8'),
  }));
}

function readRecordedInventory(): Record<string, number> {
  if (!fs.existsSync(inventoryPath)) return {};
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as Record<string, number>;
}

function reportAdded(added: readonly string[]): void {
  process.stderr.write(
    `${added.length} NEW dynamic value(s) reach a device shell (adb/hdc argv is evaluated ` +
      'as one shell string on the device):\n',
  );
  for (const entry of added) process.stderr.write(`  + ${entry}\n`);
  process.stderr.write(
    '\nQuote free-form text with shellQuoteIfNeeded (src/utils/shell-quote.ts). Only a value ' +
      'validated upstream (number, enum, resolver-checked identifier) may instead be recorded ' +
      'with `pnpm check:shell-argv --update`, so the reviewer sees the inventory grow.\n\n',
  );
}

function reportStale(stale: readonly string[]): void {
  process.stderr.write(`${stale.length} stale inventory entr(ies) no longer match a site:\n`);
  for (const entry of stale) process.stderr.write(`  - ${entry}\n`);
  process.stderr.write('\nRun `pnpm check:shell-argv --update` to shrink the inventory.\n\n');
}

function updateInventory(scanned: Record<string, number>, fileCount: number): number {
  fs.writeFileSync(inventoryPath, `${JSON.stringify(scanned, null, 2)}\n`);
  process.stdout.write(
    `Device-shell argv inventory updated: ${Object.keys(scanned).length} distinct value(s) ` +
      `across ${fileCount} production files.\n`,
  );
  return 0;
}

function reportDrift({ added, stale }: InventoryDiff): number {
  if (added.length > 0) reportAdded(added);
  if (stale.length > 0) reportStale(stale);
  return 1;
}

function main(argv: readonly string[]): number {
  const files = readSources(listProductionSourceFiles());
  const scanned = toInventory(findShellArgvValues(files));
  if (argv.includes('--update')) return updateInventory(scanned, files.length);

  const drift = diffInventory(scanned, readRecordedInventory());
  if (drift.added.length + drift.stale.length > 0) return reportDrift(drift);

  process.stdout.write(
    `Device-shell argv guard: OK — ${files.length} production files scanned, ` +
      `${Object.keys(scanned).length} inventoried dynamic value(s), no drift.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
