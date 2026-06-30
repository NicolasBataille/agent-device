import type { ReplaySuiteResult } from '../daemon/types.ts';

export type Awaitable<T> = T | Promise<T>;

export type ReplayTestReporterContext = {
  debug?: boolean;
  verbose?: boolean;
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
  onSuiteStart?(suite: ReplayTestSuiteStart, context: ReplayTestReporterContext): Awaitable<void>;
  onTestStart?(test: ReplayTestCase, context: ReplayTestReporterContext): Awaitable<void>;
  onTestStep?(test: ReplayTestStep, context: ReplayTestReporterContext): Awaitable<void>;
  onTestResult?(test: ReplayTestResult, context: ReplayTestReporterContext): Awaitable<void>;
  onSuiteEnd?(suite: ReplaySuiteResult, context: ReplayTestReporterContext): Awaitable<void>;
  getExitCode?(suite: ReplaySuiteResult): number | undefined;
};

export type ReplayTestReporterFactory = (
  context: ReplayTestReporterLoadContext,
) => ReplayTestReporter | Promise<ReplayTestReporter>;
