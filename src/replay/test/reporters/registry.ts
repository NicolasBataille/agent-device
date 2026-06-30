import type { ReplaySuiteResult } from '../../../daemon/types.ts';
import type { RequestProgressEvent } from '../../../daemon/request-progress.ts';
import { createCustomReplayTestReporter } from './custom.ts';
import { createDefaultReplayTestReporter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import { toReplayTestReporterProgressEvent } from './progress.ts';
import { buildReplayTestReporterSpecs, type ReplayTestReporterSpec } from './spec.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './types.ts';

type ReplayTestReporterLiveHook = 'onSuiteStart' | 'onTestStart' | 'onTestStep' | 'onTestResult';

type ReporterHookResult = void | Promise<void>;

export async function resolveReplayTestReporters(options: {
  reporters?: string[];
  reportJunit?: string;
  json?: boolean;
}): Promise<ReplayTestReporter[]> {
  const specs = buildReplayTestReporterSpecs(options);
  return await Promise.all(specs.map(resolveReplayTestReporter));
}

export async function runReplayTestReporters(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
  context: ReplayTestReporterContext,
): Promise<void> {
  for (const reporter of reporters) {
    await reporter.onSuiteEnd?.(suite, context);
  }
}

export function runReplayTestReporterProgress(
  reporters: ReplayTestReporter[],
  event: RequestProgressEvent,
  context: ReplayTestReporterContext,
): void {
  const reporterEvent = toReplayTestReporterProgressEvent(event);
  if (!reporterEvent) return;
  if (reporterEvent.type === 'suite-start') {
    runReplayTestReporterHook(reporters, 'onSuiteStart', context, (reporter) =>
      reporter.onSuiteStart?.(reporterEvent.suite, context),
    );
    return;
  }

  if (reporterEvent.type === 'test-start') {
    runReplayTestReporterHook(reporters, 'onTestStart', context, (reporter) =>
      reporter.onTestStart?.(reporterEvent.test, context),
    );
    return;
  }

  if (reporterEvent.type === 'test-step') {
    runReplayTestReporterHook(reporters, 'onTestStep', context, (reporter) =>
      reporter.onTestStep?.(reporterEvent.test, context),
    );
    return;
  }

  runReplayTestReporterHook(reporters, 'onTestResult', context, (reporter) =>
    reporter.onTestResult?.(reporterEvent.test, context),
  );
}

function runReplayTestReporterHook(
  reporters: ReplayTestReporter[],
  hookName: ReplayTestReporterLiveHook,
  context: ReplayTestReporterContext,
  run: (reporter: ReplayTestReporter) => ReporterHookResult | undefined,
): void {
  for (const reporter of reporters) {
    try {
      const result = run(reporter);
      if (result && typeof result === 'object' && 'then' in result) {
        // Progress hooks run from synchronous daemon stream readers, so async work
        // is observed for errors but not awaited before later hooks.
        void result.catch((error: unknown) =>
          reportReplayTestReporterHookError(reporter, hookName, context, error),
        );
      }
    } catch (error) {
      reportReplayTestReporterHookError(reporter, hookName, context, error);
    }
  }
}

function reportReplayTestReporterHookError(
  reporter: ReplayTestReporter,
  hookName: ReplayTestReporterLiveHook,
  context: ReplayTestReporterContext,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  context.stderr.write(`Reporter ${reporter.name} ${String(hookName)} failed: ${message}\n`);
}

export function getReplayTestReporterExitCode(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
): number {
  let exitCode = getReplayTestExitCode(suite);
  for (const reporter of reporters) {
    const reporterExitCode = reporter.getExitCode?.(suite);
    if (reporterExitCode !== undefined) exitCode = Math.max(exitCode, reporterExitCode);
  }
  return exitCode;
}

async function resolveReplayTestReporter(
  spec: ReplayTestReporterSpec,
): Promise<ReplayTestReporter> {
  if (spec.kind === 'custom') {
    return await createCustomReplayTestReporter(spec);
  }
  if (spec.name === 'default') return createDefaultReplayTestReporter();
  return createJunitReplayTestReporter(spec.outputPath);
}
