// `pnpm check:shell-safe` — the backstop for the typed device-shell boundary.
// Fails when a `sh.raw(...)` escape hatch or an `as ShellSafe` cast appears in
// production source without a `// shell-safe-approved: <reason>` comment on the
// line above. See model.ts for what is matched and why a static gate is sound
// HERE (guarding the escape hatch) where an inventory of every value was not.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findShellSafeMatches, unapprovedShellSafeMatches, type SourceFile } from './model.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

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

export function main(): number {
  const files = readSources(listProductionSourceFiles());
  const matches = findShellSafeMatches(files);
  const unapproved = unapprovedShellSafeMatches(matches);

  if (unapproved.length === 0) {
    process.stdout.write(
      `Device-shell escape-hatch guard: OK — ${files.length} production files scanned, ` +
        `${matches.length} approved sh.raw/as-ShellSafe site(s), no unapproved holes.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `${unapproved.length} device-shell escape-hatch(es) without a shell-safe-approved comment:\n`,
  );
  for (const match of unapproved) {
    process.stderr.write(`  ${match.file}:${match.line} [${match.kind}]: ${match.text}\n`);
    process.stderr.write(
      `::error file=${match.file},line=${match.line},title=Unapproved device-shell escape hatch::${match.text}\n`,
    );
  }
  process.stderr.write(
    '\nEvery sh.raw(...) fragment and `as ShellSafe` cast must carry a ' +
      '`// shell-safe-approved: <why this is safe>` comment on the line above. Prefer sh.arg() for ' +
      'a dynamic value — sh.raw is only for an author-written, self-quoted shell fragment.\n\n',
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
