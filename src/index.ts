export { createAgentDeviceClient } from './client/client.ts';
export { createLocalArtifactAdapter } from './io.ts';
export { AppError, isAgentDeviceError, normalizeAgentDeviceError } from './kernel/errors.ts';
export { centerOfRect } from './kernel/snapshot.ts';
export { createDefaultReplayTestReporter } from './cli-test-reporters/default.ts';
export {
  createReplayTestProgressRenderer,
  replayTestStatusIcon,
} from './cli-test-progress.ts';
export { formatDurationSeconds as formatReplayTestDuration } from './utils/duration-format.ts';

export type {
  ArtifactAdapter,
  ArtifactDescriptor,
  CreateTempFileOptions,
  FileInputRef,
  FileOutputRef,
  LocalArtifactAdapterOptions,
  OutputVisibility,
  ReserveOutputOptions,
  ReservedOutputFile,
  ResolveInputOptions,
  ResolvedInputFile,
  TemporaryFile,
} from './io.ts';

export type { AppErrorCode, NormalizedError } from './kernel/errors.ts';

export type {
  Awaitable,
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterFactory,
  ReplayTestReporterLoadContext,
  ReplayTestReporterProgressEvent,
  ReplayTestReporterStream,
  ReplayTestCase,
  ReplayTestResult,
  ReplayTestStep,
  ReplayTestSuiteStart,
} from './cli-test-reporters/types.ts';

export type {
  ReplayTestProgressFormatOptions,
  ReplayTestProgressRender,
  ReplayTestProgressRenderer,
} from './cli-test-progress.ts';

export type { CommandResult } from './core/command-descriptor/command-result.ts';
export type { ResponseLevel } from './kernel/contracts.ts';
export type { BootCommandResult, ShutdownCommandResult } from './contracts/device.ts';
export type { ViewportCommandResult } from './contracts/viewport.ts';

export type {
  AgentDeviceClient,
  AgentDeviceClientConfig,
  AgentDeviceCommandClient,
  AgentDeviceDaemonTransport,
  AlertCommandResult,
  AppListOptions,
  AppStateCommandResult,
  AppSwitcherCommandResult,
  BackCommandOptions,
  BackCommandResult,
  ClipboardCommandResult,
  HomeCommandResult,
  KeyboardCommandResult,
  RecordOptions,
  RotateCommandOptions,
  RotateCommandResult,
  ScrollOptions,
} from './client/client.ts';

export type { SnapshotNode } from './kernel/snapshot.ts';
