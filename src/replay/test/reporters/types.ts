import type { ReplaySuiteResult } from '../../../daemon/types.ts';

export type ReplayTestReporterContext = {
  debug?: boolean;
  verbose?: boolean;
  stdout: ReplayTestReporterStream;
  stderr: ReplayTestReporterStream;
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

export type ReplayTestSuiteStart = {
  total: number;
  runnable: number;
  skipped: number;
  artifactsDir: string;
  shardMode?: 'all' | 'split';
  shardCount?: number;
};

export type ReplayTestCase = {
  file: string;
  title?: string;
  index: number;
  total: number;
  attempt?: number;
  maxAttempts?: number;
  session?: string;
  artifactsDir?: string;
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
};

export type ReplayTestStep = ReplayTestCase & {
  stepIndex?: number;
  stepTotal?: number;
};

export type ReplayTestResult = ReplayTestCase & {
  status: 'pass' | 'fail' | 'skip';
  durationMs?: number;
  retrying?: boolean;
  message?: string;
  hint?: string;
};

export type ReplayTestReporterProgressEvent =
  | { type: 'suite-start'; suite: ReplayTestSuiteStart }
  | { type: 'test-start'; test: ReplayTestCase }
  | { type: 'test-step'; test: ReplayTestStep }
  | { type: 'test-result'; test: ReplayTestResult };

export type ReplayTestReporter = {
  name: string;
  onSuiteStart?(
    suite: ReplayTestSuiteStart,
    context: ReplayTestReporterContext,
  ): void | Promise<void>;
  onTestStart?(test: ReplayTestCase, context: ReplayTestReporterContext): void | Promise<void>;
  onTestStep?(test: ReplayTestStep, context: ReplayTestReporterContext): void | Promise<void>;
  onTestResult?(test: ReplayTestResult, context: ReplayTestReporterContext): void | Promise<void>;
  onSuiteEnd?(suite: ReplaySuiteResult, context: ReplayTestReporterContext): void | Promise<void>;
  getExitCode?(suite: ReplaySuiteResult): number | undefined;
};

export type ReplayTestReporterFactory = (
  context: ReplayTestReporterLoadContext,
) => ReplayTestReporter | Promise<ReplayTestReporter>;
