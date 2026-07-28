// Append one repo-health snapshot to the main-branch metric history (#1424):
//
//   pnpm repo-health:history --snapshot .tmp/repo-health.json --history-dir <checkout of the ref>
//
// The push-to-main workflow owns git (fetch the history ref, run this, commit, push with
// compare-and-swap and one retry); this command owns only the file fold, so the retry after a
// losing push is "re-read the ref and run it again". Appending the same commit twice is a no-op,
// which is what makes that retry safe.

import fs from 'node:fs';
import path from 'node:path';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runAsMain } from '../lib/run-as-main.ts';
import type { RepoHealthSnapshot } from '../repo-health/model.ts';
import { appendEntry, historyShardName, HISTORY_DIR } from './history.ts';

const USAGE = `Usage: pnpm repo-health:history --snapshot <path> --history-dir <path>

Options:
  --snapshot <path>     Repo-health snapshot JSON to append (pnpm repo-health --out).
  --history-dir <path>  Working copy of the history ref; the shard lands in its ${HISTORY_DIR}/.
`;

function run(argv: readonly string[]): number {
  const values = parseScriptArgs(argv, USAGE, {
    snapshot: { type: 'string', default: '.tmp/repo-health.json' },
    'history-dir': { type: 'string' },
  });
  if (typeof values['history-dir'] !== 'string') throw new Error('--history-dir is required');

  const snapshot = JSON.parse(
    fs.readFileSync(path.resolve(values.snapshot ?? ''), 'utf8'),
  ) as RepoHealthSnapshot;
  const shard = path.join(
    path.resolve(values['history-dir']),
    HISTORY_DIR,
    historyShardName(snapshot.provenance.generatedAt),
  );
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  const existing = fs.existsSync(shard) ? fs.readFileSync(shard, 'utf8') : '';
  const outcome = appendEntry(existing, snapshot);
  if (!outcome.appended) {
    process.stdout.write(
      `repo-health:history: ${snapshot.provenance.commit.slice(0, 12)} is already in ${path.basename(shard)}; nothing to do.\n`,
    );
    return 0;
  }
  fs.writeFileSync(shard, outcome.text);
  process.stdout.write(
    `repo-health:history: appended ${snapshot.provenance.commit.slice(0, 12)} to ${path.basename(shard)}.\n`,
  );
  return 0;
}

runAsMain(import.meta.url, 'repo-health:history', run);
