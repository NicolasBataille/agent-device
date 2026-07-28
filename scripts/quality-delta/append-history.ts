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

/** The shard file this snapshot belongs in, created empty if the month has no entries yet. */
function shardFor(historyDir: string, snapshot: RepoHealthSnapshot): string {
  const shard = path.join(
    path.resolve(historyDir),
    HISTORY_DIR,
    historyShardName(snapshot.provenance.generatedAt),
  );
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  return shard;
}

function appendSnapshot(historyDir: string, snapshot: RepoHealthSnapshot): string {
  const shard = shardFor(historyDir, snapshot);
  const outcome = appendEntry(fs.existsSync(shard) ? fs.readFileSync(shard, 'utf8') : '', snapshot);
  const commit = snapshot.provenance.commit.slice(0, 12);
  if (!outcome.appended) return `${commit} is already in ${path.basename(shard)}; nothing to do.`;
  fs.writeFileSync(shard, outcome.text);
  return `appended ${commit} to ${path.basename(shard)}.`;
}

function run(argv: readonly string[]): number {
  const values = parseScriptArgs(argv, USAGE, {
    snapshot: { type: 'string', default: '.tmp/repo-health.json' },
    'history-dir': { type: 'string' },
  });
  const historyDir = values['history-dir'];
  if (typeof historyDir !== 'string') throw new Error('--history-dir is required');

  const snapshot = JSON.parse(
    fs.readFileSync(path.resolve(values.snapshot ?? ''), 'utf8'),
  ) as RepoHealthSnapshot;
  process.stdout.write(`repo-health:history: ${appendSnapshot(historyDir, snapshot)}\n`);
  return 0;
}

runAsMain(import.meta.url, 'repo-health:history', run);
