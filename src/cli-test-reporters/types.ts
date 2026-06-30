import type { RequestProgressEvent } from '../daemon/request-progress.ts';
import type { ReplaySuiteResult } from '../daemon/types.ts';

export type ReplayTestReporterContext = {
  debug?: boolean;
  stdout: ReplayTestReporterStream;
  stderr: ReplayTestReporterStream;
  mkdir(path: string): void;
  writeFile(path: string, contents: string): void;
};

export type ReplayTestReporterStream = {
  isTTY: boolean;
  columns?: number;
  write(text: string): void;
};

export type ReplayTestReporterLoadContext = {
  spec: string;
  modulePath: string;
};

export type ReplayTestReporter = {
  name: string;
  onProgress?(event: RequestProgressEvent, context: ReplayTestReporterContext): void;
  onSuiteEnd?(suite: ReplaySuiteResult, context: ReplayTestReporterContext): Promise<void> | void;
  getExitCode?(suite: ReplaySuiteResult): number | undefined;
};

export type ReplayTestReporterFactory = (
  context: ReplayTestReporterLoadContext,
) => ReplayTestReporter | Promise<ReplayTestReporter>;
