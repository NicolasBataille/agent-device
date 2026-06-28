import type { SnapshotBackend } from './utils/snapshot.ts';
import type { Platform } from './utils/device.ts';
import { isRecord } from './utils/parsing.ts';

const SLOW_SNAPSHOT_P95_WARNING_MS = 1_500;
const SNAPSHOT_TIMING_SAMPLE_LIMIT = 50;
const SNAPSHOT_TIMING_PHASE_LIMIT = 24;
const SNAPSHOT_TIMING_PHASE_KEY_PATTERN = /^[a-z0-9_.-]{1,64}$/;

export type SnapshotTimingSample = {
  durationMs: number;
  backend?: SnapshotBackend;
  platform?: Platform;
  phases?: Record<string, number>;
};

export type SnapshotTimingStats = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowThresholdMs: number;
  platform?: Platform;
  backends?: Record<string, number>;
};

export type SnapshotDiagnosticsState = {
  samples: SnapshotTimingSample[];
};

export type SnapshotDiagnosticsSummary = {
  stats: SnapshotTimingStats;
  phases?: Record<string, SnapshotTimingStats>;
  warning?: string;
};

export type SnapshotRunnerTiming = {
  totalMs?: number;
  phases?: Record<string, number>;
  backends?: Record<string, number>;
  selectedBackend?: string;
};

export function recordSnapshotTiming(
  session: { snapshotDiagnostics?: SnapshotDiagnosticsState } | undefined,
  sample: SnapshotTimingSample,
): void {
  if (!session) return;
  const diagnostics = (session.snapshotDiagnostics ??= { samples: [] });
  diagnostics.samples.push({
    ...sample,
    durationMs: Math.max(0, Math.round(sample.durationMs)),
    ...(sample.phases ? { phases: normalizeTimingPhases(sample.phases) } : {}),
  });
  if (diagnostics.samples.length > SNAPSHOT_TIMING_SAMPLE_LIMIT) {
    diagnostics.samples.splice(0, diagnostics.samples.length - SNAPSHOT_TIMING_SAMPLE_LIMIT);
  }
}

export function summarizeSnapshotDiagnostics(
  session: { snapshotDiagnostics?: SnapshotDiagnosticsState } | undefined,
): SnapshotDiagnosticsSummary | undefined {
  const samples = session?.snapshotDiagnostics?.samples;
  if (!samples || samples.length === 0) return undefined;
  return summarizeSnapshotTimingSamples(samples);
}

export function summarizeSnapshotTimingSamples(
  samples: SnapshotTimingSample[],
): SnapshotDiagnosticsSummary | undefined {
  if (samples.length === 0) return undefined;
  const stats = buildSnapshotTimingStats(samples);
  const phases = buildSnapshotPhaseStats(samples);
  return {
    stats,
    ...(phases ? { phases } : {}),
    ...(stats.p95Ms >= SLOW_SNAPSHOT_P95_WARNING_MS
      ? { warning: formatSlowSnapshotWarning(stats) }
      : {}),
  };
}

export function mergeSnapshotDiagnostics(
  summaries: Array<SnapshotDiagnosticsSummary | undefined>,
): SnapshotDiagnosticsSummary | undefined {
  const samples = summaries.flatMap((summary) => samplesFromStats(summary?.stats));
  if (samples.length === 0) return undefined;
  const stats = buildSnapshotTimingStats(samples);
  const phases = mergeSnapshotPhaseStats(summaries);
  return {
    stats,
    ...(phases ? { phases } : {}),
    ...(stats.p95Ms >= SLOW_SNAPSHOT_P95_WARNING_MS
      ? { warning: formatSlowSnapshotWarning(stats) }
      : {}),
  };
}

export function readSnapshotDiagnosticsSummary(
  value: unknown,
): SnapshotDiagnosticsSummary | undefined {
  if (!isRecord(value)) return undefined;
  const stats = readSnapshotTimingStats(value.stats);
  if (!stats) return undefined;
  const warning = typeof value.warning === 'string' ? value.warning : undefined;
  const phases = readSnapshotPhaseStats(value.phases);
  return { stats, ...(phases ? { phases } : {}), ...(warning ? { warning } : {}) };
}

export function readSnapshotRunnerTiming(value: unknown): SnapshotRunnerTiming | undefined {
  if (!isRecord(value)) return undefined;
  const totalMs = readTimingNumber(value.totalMs);
  const phases = normalizeTimingPhases({
    ...(isRecord(value.phases) ? readTimingNumberRecord(value.phases) : {}),
    ...(totalMs !== undefined ? { runner_total: totalMs } : {}),
    ...prefixTimingPhases('backend', isRecord(value.backends) ? value.backends : undefined),
  });
  const selectedBackend =
    typeof value.selectedBackend === 'string' && value.selectedBackend.trim().length > 0
      ? value.selectedBackend
      : undefined;
  if (totalMs === undefined && Object.keys(phases).length === 0 && !selectedBackend) {
    return undefined;
  }
  return {
    ...(totalMs !== undefined ? { totalMs } : {}),
    ...(Object.keys(phases).length > 0 ? { phases } : {}),
    ...(selectedBackend ? { selectedBackend } : {}),
  };
}

function buildSnapshotTimingStats(samples: SnapshotTimingSample[]): SnapshotTimingStats {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    count: durations.length,
    p50Ms: percentileNearestRank(durations, 50),
    p95Ms: percentileNearestRank(durations, 95),
    maxMs: durations[durations.length - 1] ?? 0,
    slowThresholdMs: SLOW_SNAPSHOT_P95_WARNING_MS,
    ...singlePlatform(samples),
    ...backendCounts(samples),
  };
}

function buildSnapshotPhaseStats(
  samples: SnapshotTimingSample[],
): Record<string, SnapshotTimingStats> | undefined {
  const phaseSamples = new Map<string, SnapshotTimingSample[]>();
  for (const sample of samples) {
    if (!sample.phases) continue;
    for (const [phase, durationMs] of Object.entries(sample.phases)) {
      const current = phaseSamples.get(phase) ?? [];
      current.push({
        durationMs,
        platform: sample.platform,
        backend: sample.backend,
      });
      phaseSamples.set(phase, current);
    }
  }
  if (phaseSamples.size === 0) return undefined;
  return Object.fromEntries(
    Array.from(phaseSamples.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, SNAPSHOT_TIMING_PHASE_LIMIT)
      .map(([phase, phaseTimingSamples]) => [phase, buildSnapshotTimingStats(phaseTimingSamples)]),
  );
}

function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.ceil((percentile / 100) * values.length) - 1);
  return values[Math.min(index, values.length - 1)] ?? 0;
}

function singlePlatform(samples: SnapshotTimingSample[]): Pick<SnapshotTimingStats, 'platform'> {
  const platforms = samples
    .map((sample) => sample.platform)
    .filter((platform): platform is Platform => Boolean(platform));
  const uniquePlatforms = new Set(platforms);
  return uniquePlatforms.size === 1 ? { platform: platforms[0] } : {};
}

function backendCounts(samples: SnapshotTimingSample[]): Pick<SnapshotTimingStats, 'backends'> {
  const backends: Record<string, number> = {};
  for (const sample of samples) {
    if (!sample.backend) continue;
    backends[sample.backend] = (backends[sample.backend] ?? 0) + 1;
  }
  return Object.keys(backends).length > 0 ? { backends } : {};
}

function formatSlowSnapshotWarning(stats: SnapshotTimingStats): string {
  const platform = stats.platform ? `${stats.platform} ` : '';
  return `Warning: ${platform}snapshots are slow in this run: p95 ${stats.p95Ms}ms over ${stats.count} captures. Possible causes: device load, app or dev server stuck, helper fallback, or stale daemon.`;
}

function readSnapshotTimingStats(value: unknown): SnapshotTimingStats | undefined {
  if (!isRecord(value)) return undefined;
  const required = readRequiredSnapshotTimingStats(value);
  if (!required) return undefined;
  return {
    ...required,
    ...readOptionalSnapshotTimingStats(value),
  };
}

function readRequiredSnapshotTimingStats(
  record: Record<string, unknown>,
):
  | Pick<SnapshotTimingStats, 'count' | 'p50Ms' | 'p95Ms' | 'maxMs' | 'slowThresholdMs'>
  | undefined {
  const entries = {
    count: record.count,
    p50Ms: record.p50Ms,
    p95Ms: record.p95Ms,
    maxMs: record.maxMs,
    slowThresholdMs: record.slowThresholdMs,
  };
  if (Object.values(entries).some((value) => typeof value !== 'number')) return undefined;
  return entries as Pick<
    SnapshotTimingStats,
    'count' | 'p50Ms' | 'p95Ms' | 'maxMs' | 'slowThresholdMs'
  >;
}

function readBackendCounts(value: Record<string, unknown>): Record<string, number> | undefined {
  const entries = Object.entries(value).filter((entry): entry is [string, number] => {
    return typeof entry[1] === 'number';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readSnapshotPhaseStats(value: unknown): Record<string, SnapshotTimingStats> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key]) => SNAPSHOT_TIMING_PHASE_KEY_PATTERN.test(key))
    .slice(0, SNAPSHOT_TIMING_PHASE_LIMIT)
    .flatMap(([key, stats]) => {
      const timingStats = readSnapshotTimingStats(stats);
      return timingStats ? ([[key, timingStats]] as const) : [];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeSnapshotPhaseStats(
  summaries: Array<SnapshotDiagnosticsSummary | undefined>,
): Record<string, SnapshotTimingStats> | undefined {
  const phaseSamples = new Map<string, SnapshotTimingSample[]>();
  for (const summary of summaries) {
    for (const [phase, stats] of Object.entries(summary?.phases ?? {})) {
      const current = phaseSamples.get(phase) ?? [];
      current.push(...samplesFromStats(stats));
      phaseSamples.set(phase, current);
    }
  }
  if (phaseSamples.size === 0) return undefined;
  return Object.fromEntries(
    Array.from(phaseSamples.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, SNAPSHOT_TIMING_PHASE_LIMIT)
      .map(([phase, samples]) => [phase, buildSnapshotTimingStats(samples)]),
  );
}

function readOptionalSnapshotTimingStats(
  record: Record<string, unknown>,
): Pick<SnapshotTimingStats, 'platform' | 'backends'> {
  const platform = typeof record.platform === 'string' ? record.platform : undefined;
  const backends = isRecord(record.backends) ? readBackendCounts(record.backends) : undefined;
  return {
    ...(platform ? { platform: platform as SnapshotTimingStats['platform'] } : {}),
    ...(backends ? { backends } : {}),
  };
}

function samplesFromStats(stats: SnapshotTimingStats | undefined): SnapshotTimingSample[] {
  if (!stats || stats.count <= 0) return [];
  const platform = stats.platform;
  if (stats.count === 1) return [{ durationMs: stats.maxMs, platform }];
  if (stats.count === 2) {
    return [
      { durationMs: stats.p50Ms, platform },
      { durationMs: stats.maxMs, platform },
    ];
  }
  return [
    ...Array.from({ length: stats.count - 3 }, () => ({ durationMs: stats.p50Ms, platform })),
    { durationMs: stats.p50Ms, platform },
    { durationMs: stats.p95Ms, platform },
    { durationMs: stats.maxMs, platform },
  ];
}

function normalizeTimingPhases(phases: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(phases)
      .filter(([key, value]) => {
        return SNAPSHOT_TIMING_PHASE_KEY_PATTERN.test(key) && Number.isFinite(value);
      })
      .slice(0, SNAPSHOT_TIMING_PHASE_LIMIT)
      .map(([key, value]) => [key, Math.max(0, Math.round(value))]),
  );
}

function readTimingNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTimingNumberRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => {
      return readTimingNumber(entry[1]) !== undefined;
    }),
  );
}

function prefixTimingPhases(
  prefix: string,
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(readTimingNumberRecord(value)).map(([key, durationMs]) => [
      `${prefix}.${key}`,
      durationMs,
    ]),
  );
}
