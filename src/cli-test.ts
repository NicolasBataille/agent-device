import fs from 'node:fs';
import type { RequestProgressEvent } from './daemon/request-progress.ts';
import type { ReplaySuiteResult } from './daemon/types.ts';
import {
  getReplayTestReporterExitCode,
  resolveReplayTestReporters,
  runReplayTestReporterProgress,
  runReplayTestReporters,
} from './cli-test-reporters/registry.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './cli-test-reporters/types.ts';
import { printJson } from './utils/output.ts';

export type ReplayTestReporterRuntime = {
  reporters: ReplayTestReporter[];
  context: ReplayTestReporterContext;
  onProgress(event: RequestProgressEvent): void;
};

export async function renderReplayTestResponse(options: {
  suite: ReplaySuiteResult;
  json?: boolean;
  debug?: boolean;
  reporter?: string[];
  reportJunit?: string;
  reporterRuntime?: ReplayTestReporterRuntime;
}): Promise<number> {
  const { suite, json, debug, reporter, reportJunit } = options;
  const runtime =
    options.reporterRuntime ??
    (await createReplayTestReporterRuntime({ debug, reporter, reportJunit, json }));
  await runReplayTestReporters(runtime.reporters, suite, runtime.context);
  if (json) {
    printJson({ success: true, data: suite });
  }
  return getReplayTestReporterExitCode(runtime.reporters, suite);
}

export async function createReplayTestReporterRuntime(options: {
  debug?: boolean;
  reporter?: string[];
  reportJunit?: string;
  json?: boolean;
}): Promise<ReplayTestReporterRuntime> {
  const reporters = await resolveReplayTestReporters({
    reporters: options.reporter,
    reportJunit: options.reportJunit,
    json: options.json,
  });
  const context = createReplayTestReporterContext({ debug: options.debug });
  return {
    reporters,
    context,
    onProgress(event) {
      runReplayTestReporterProgress(reporters, event, context);
    },
  };
}

function createReplayTestReporterContext(options: { debug?: boolean }): ReplayTestReporterContext {
  return {
    debug: options.debug,
    stdout: {
      isTTY: process.stdout.isTTY === true,
      columns: process.stdout.columns,
      write: (text) => process.stdout.write(text),
    },
    stderr: {
      isTTY: process.stderr.isTTY === true,
      columns: process.stderr.columns,
      write: (text) => process.stderr.write(text),
    },
    mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents, 'utf8'),
  };
}
