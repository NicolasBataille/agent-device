#!/usr/bin/env node
// Interleaved A/B harness for the #1961 `module.enableCompileCache()` measurement.
// Retained so the numbers in docs/cli-compile-cache-startup-measurement.md can be
// recomputed or re-measured by someone else.
//
//   bench  run both arms and append raw per-sample elapsed times to a JSON file
//   stats  recompute medians + bootstrap CIs from that JSON without re-running
//
// Both arms are copies of bin/agent-device.mjs pointed at the same unchanged dist/,
// differing only by a leading module.enableCompileCache(). Samples alternate arms and
// flip the arm order every iteration, which removes ORDER bias between the arms. It does
// not make the host quiet: record the observed load and treat a loaded run accordingly.
//
// Examples:
//   node scripts/perf/compile-cache-ab.mjs bench --runs 120 --mode warm \
//     --routes "--version|--help" --out docs/cli-compile-cache-startup-samples.json
//   node scripts/perf/compile-cache-ab.mjs stats \
//     --in docs/cli-compile-cache-startup-samples.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_DIR = path.join(os.tmpdir(), 'agent-device-compile-cache-ab');
// enableCompileCache() with no argument caches here (Node docs).
const CACHE_DIR = path.join(os.tmpdir(), 'node-compile-cache');
const BOOTSTRAP_ITERATIONS = 20_000;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// Build the two bin variants: baseline is the committed entry verbatim, the other is the
// same file with enableCompileCache() prepended (what shipping the change would look like).
function prepareArms() {
  const baselineSource = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'agent-device.mjs'), 'utf8');
  const shebang = '#!/usr/bin/env node\n';
  const body = baselineSource.startsWith(shebang)
    ? baselineSource.slice(shebang.length)
    : baselineSource;
  const compileCacheSource = `${shebang}import { enableCompileCache } from 'node:module';\nenableCompileCache();\n${body}`;

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK_DIR, 'bin'), { recursive: true });
  // The entry resolves dist/ relative to its own parent directory, so link the real one.
  fs.symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(WORK_DIR, 'dist'), 'dir');
  const arms = {
    baseline: path.join(WORK_DIR, 'bin', 'baseline.mjs'),
    compileCache: path.join(WORK_DIR, 'bin', 'compile-cache.mjs'),
  };
  fs.writeFileSync(arms.baseline, baselineSource);
  fs.writeFileSync(arms.compileCache, compileCacheSource);
  return arms;
}

function invoke(binPath, args, cwd) {
  const started = process.hrtime.bigint();
  try {
    execFileSync(process.execPath, [binPath, ...args], {
      cwd,
      stdio: 'ignore',
      timeout: 300_000,
    });
  } catch {
    // Non-zero exits are expected for validation-error routes; the sample still counts.
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function wipeCompileCache() {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
}

function bench(opts) {
  const arms = prepareArms();
  const routes = String(opts.routes ?? '--version|--help')
    .split('|')
    .map((r) => r.trim())
    .filter(Boolean);
  const runs = Number(opts.runs ?? 120);
  const mode = opts.mode === 'cold' ? 'cold' : 'warm';
  // Session identity is derived from cwd; a route that reaches the daemon must always run
  // from the same directory or it opens a second session that cannot claim the device.
  const cwd = opts.cwd ? path.resolve(opts.cwd) : REPO_ROOT;
  const outPath = path.resolve(opts.out ?? 'compile-cache-samples.json');

  const record = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : { runs: [] };

  for (const route of routes) {
    const args = route.split(/\s+/);
    const samples = { baseline: [], compileCache: [] };
    if (mode === 'warm') {
      for (let i = 0; i < 3; i += 1) {
        invoke(arms.baseline, args, cwd);
        invoke(arms.compileCache, args, cwd);
      }
    }
    const loadStart = os.loadavg()[0];
    for (let i = 0; i < runs; i += 1) {
      const order = i % 2 === 0 ? ['baseline', 'compileCache'] : ['compileCache', 'baseline'];
      for (const arm of order) {
        // Cold mode wipes before BOTH arms so filesystem state is symmetric between them.
        if (mode === 'cold') wipeCompileCache();
        samples[arm].push(invoke(arms[arm], args, cwd));
      }
    }
    record.runs.push({
      route,
      mode,
      runs,
      node: process.version,
      measuredAt: new Date().toISOString(),
      loadAvg1min: { start: round(loadStart, 2), end: round(os.loadavg()[0], 2) },
      samplesMs: {
        baseline: samples.baseline.map((v) => round(v, 3)),
        compileCache: samples.compileCache.map((v) => round(v, 3)),
      },
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    report(record.runs.at(-1));
  }
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Bootstrap CI on median(compileCache) - median(baseline). Deterministic seed so the
// published interval reproduces exactly from the retained samples.
function bootstrapMedianDiffCi(baseline, compileCache) {
  let seed = 1234;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const diffs = [];
  for (let i = 0; i < BOOTSTRAP_ITERATIONS; i += 1) {
    const ra = Array.from(
      { length: baseline.length },
      () => baseline[(next() * baseline.length) | 0],
    );
    const rb = Array.from(
      { length: compileCache.length },
      () => compileCache[(next() * compileCache.length) | 0],
    );
    diffs.push(median(rb) - median(ra));
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * diffs.length)], diffs[Math.floor(0.975 * diffs.length)]];
}

function report(run) {
  const { baseline, compileCache } = run.samplesMs;
  const mb = median(baseline);
  const mc = median(compileCache);
  const [lo, hi] = bootstrapMedianDiffCi(baseline, compileCache);
  const verdict = hi < 0 ? 'faster' : lo > 0 ? 'slower' : 'no significant difference';
  process.stdout.write(
    `${run.route}  [${run.mode}]  n=${baseline.length}/arm  load ${run.loadAvg1min.start}->${run.loadAvg1min.end}\n` +
      `  baseline ${mb.toFixed(1)}ms  compile-cache ${mc.toFixed(1)}ms  ` +
      `delta ${(mc - mb >= 0 ? '+' : '') + (mc - mb).toFixed(1)}ms  ` +
      `95% CI [${lo >= 0 ? '+' : ''}${lo.toFixed(1)}, ${hi >= 0 ? '+' : ''}${hi.toFixed(1)}] ms  ` +
      `-> ${verdict}\n`,
  );
}

function stats(opts) {
  const inPath = path.resolve(opts.in ?? 'compile-cache-samples.json');
  const record = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  for (const run of record.runs) report(run);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'stats';
if (command === 'bench') bench(args);
else if (command === 'stats') stats(args);
else {
  process.stderr.write('Usage: compile-cache-ab.mjs <bench|stats> [--routes …] [--runs n]\n');
  process.exit(1);
}
