import { buildPrimaryEnvVarName, parseSourceValue } from '../utils/source-value.ts';
import { listCliCommandNames } from '../command-catalog.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  GLOBAL_FLAG_KEYS,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';

export type OptionSpec = {
  key: FlagKey;
  flagDefinitions: readonly FlagDefinition[];
  config: {
    trust: ConfigTrust;
    key: string;
  };
  env: {
    names: readonly string[];
  };
  supportsCommand(command: string | null): boolean;
};

export type ConfigTrust = 'project-safe' | 'user-or-explicit-only' | 'disabled';

const ENV_EXCLUDED_FLAG_KEYS = new Set<FlagKey>(['appsFilter', 'iosSimulatorDeviceSet']);

let optionSpecs: OptionSpec[] | undefined;
let optionSpecByKey: Map<FlagKey, OptionSpec> | undefined;

export function getOptionSpec(key: FlagKey): OptionSpec | undefined {
  return getOptionSpecsByKey().get(key);
}

export function getConfigurableOptionSpecs(command: string | null): OptionSpec[] {
  return getOptionSpecs().filter(
    (spec) => spec.config.trust !== 'disabled' && spec.supportsCommand(command),
  );
}

function getOptionSpecs(): OptionSpec[] {
  if (optionSpecs) return optionSpecs;
  optionSpecs = buildOptionSpecs();
  optionSpecByKey = new Map(optionSpecs.map((spec) => [spec.key, spec]));
  return optionSpecs;
}

function getOptionSpecsByKey(): Map<FlagKey, OptionSpec> {
  getOptionSpecs();
  if (!optionSpecByKey) throw new Error('Option specs were not initialized.');
  return optionSpecByKey;
}

export function isFlagSupportedForCommand(key: FlagKey, command: string | null): boolean {
  return getOptionSpec(key)?.supportsCommand(command) ?? false;
}

export function parseOptionValueFromSource(
  spec: OptionSpec,
  value: unknown,
  sourceLabel: string,
  rawKey: string,
): unknown {
  return parseSourceValue(resolveSourceValueDefinition(spec), value, sourceLabel, rawKey);
}

function buildOptionSpecs(): OptionSpec[] {
  const definitionsByKey = new Map<FlagKey, FlagDefinition[]>();
  for (const definition of getFlagDefinitions()) {
    const existing = definitionsByKey.get(definition.key);
    if (existing) existing.push(definition);
    else definitionsByKey.set(definition.key, [definition]);
  }

  const supportedCommandsByKey = new Map<FlagKey, Set<string>>();
  for (const key of GLOBAL_FLAG_KEYS) {
    supportedCommandsByKey.set(key, new Set(['*']));
  }
  for (const command of listCliCommandNames()) {
    const schema = getCliCommandSchema(command);
    for (const key of [...(schema.allowedFlags ?? []), ...(schema.supportedFlags ?? [])]) {
      const existing = supportedCommandsByKey.get(key);
      if (existing && existing.has('*')) continue;
      if (existing) existing.add(command);
      else supportedCommandsByKey.set(key, new Set([command]));
    }
  }

  return [...definitionsByKey.entries()]
    .map(([key, flagDefinitions]) => ({
      key,
      flagDefinitions,
      config: {
        trust: configTrustForFlag(key),
        key,
      },
      env: {
        names: ENV_EXCLUDED_FLAG_KEYS.has(key) ? [] : [buildPrimaryEnvVarName(key)],
      },
      supportsCommand(command: string | null): boolean {
        const supported = supportedCommandsByKey.get(key);
        if (!supported) return false;
        if (supported.has('*')) return true;
        if (!command) return false;
        return supported.has(command);
      },
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

// This record is deliberately exhaustive over FlagKey. A new CLI flag must be
// classified before it can silently become valid in repository config.
const CONFIG_TRUST_BY_FLAG = {
  config: 'disabled',
  remoteConfig: 'disabled',
  help: 'disabled',
  version: 'disabled',
  batchSteps: 'disabled',
  githubActionsArtifact: 'disabled',
  stateDir: 'user-or-explicit-only',
  daemonBaseUrl: 'user-or-explicit-only',
  daemonAuthToken: 'user-or-explicit-only',
  daemonTransport: 'user-or-explicit-only',
  daemonServerMode: 'user-or-explicit-only',
  proxyHost: 'user-or-explicit-only',
  proxyPort: 'user-or-explicit-only',
  tenant: 'user-or-explicit-only',
  sessionIsolation: 'user-or-explicit-only',
  runId: 'user-or-explicit-only',
  leaseId: 'user-or-explicit-only',
  leaseBackend: 'user-or-explicit-only',
  provider: 'user-or-explicit-only',
  providerSessionId: 'user-or-explicit-only',
  providerApp: 'user-or-explicit-only',
  providerOsVersion: 'user-or-explicit-only',
  providerProject: 'user-or-explicit-only',
  providerBuild: 'user-or-explicit-only',
  providerSessionName: 'user-or-explicit-only',
  providerDeviceOrientation: 'user-or-explicit-only',
  providerGeoLocation: 'user-or-explicit-only',
  providerTimezone: 'user-or-explicit-only',
  providerLanguage: 'user-or-explicit-only',
  providerLocale: 'user-or-explicit-only',
  providerNetworkProfile: 'user-or-explicit-only',
  providerCustomNetwork: 'user-or-explicit-only',
  providerNoResignApp: 'user-or-explicit-only',
  awsProjectArn: 'user-or-explicit-only',
  awsDeviceArn: 'user-or-explicit-only',
  awsAppArn: 'user-or-explicit-only',
  awsRegion: 'user-or-explicit-only',
  awsInteractionMode: 'user-or-explicit-only',
  header: 'user-or-explicit-only',
  installSource: 'user-or-explicit-only',
  metroProjectRoot: 'user-or-explicit-only',
  metroKind: 'user-or-explicit-only',
  metroPublicBaseUrl: 'user-or-explicit-only',
  metroProxyBaseUrl: 'user-or-explicit-only',
  metroBearerToken: 'user-or-explicit-only',
  metroPreparePort: 'user-or-explicit-only',
  metroListenHost: 'user-or-explicit-only',
  metroStatusHost: 'user-or-explicit-only',
  metroStartupTimeoutMs: 'user-or-explicit-only',
  metroProbeTimeoutMs: 'user-or-explicit-only',
  metroRuntimeFile: 'user-or-explicit-only',
  metroNoReuseExisting: 'user-or-explicit-only',
  metroNoInstallDeps: 'user-or-explicit-only',
  metroHost: 'user-or-explicit-only',
  metroPort: 'user-or-explicit-only',
  bundleUrl: 'user-or-explicit-only',
  iosSimulatorDeviceSet: 'user-or-explicit-only',
  iosXctestrunFile: 'user-or-explicit-only',
  iosXctestDerivedDataPath: 'user-or-explicit-only',
  iosXctestEnvDir: 'user-or-explicit-only',
  androidDeviceAllowlist: 'user-or-explicit-only',
  targetApp: 'user-or-explicit-only',
  artifactsDir: 'user-or-explicit-only',
  artifact: 'user-or-explicit-only',
  dsym: 'user-or-explicit-only',
  searchPath: 'user-or-explicit-only',
  out: 'user-or-explicit-only',
  steps: 'user-or-explicit-only',
  stepsFile: 'user-or-explicit-only',
  replayEnv: 'user-or-explicit-only',
  replayShellEnv: 'user-or-explicit-only',
  json: 'project-safe',
  platform: 'project-safe',
  target: 'project-safe',
  device: 'project-safe',
  udid: 'project-safe',
  serial: 'project-safe',
  session: 'project-safe',
  sessionLock: 'project-safe',
  activity: 'project-safe',
  launchConsole: 'project-safe',
  launchArgs: 'project-safe',
  launchUrl: 'project-safe',
  remote: 'project-safe',
  deviceHub: 'project-safe',
  testIme: 'project-safe',
  appsFilter: 'project-safe',
  clean: 'project-safe',
  force: 'project-safe',
  stale: 'project-safe',
  relaunch: 'project-safe',
  shutdown: 'project-safe',
  surface: 'project-safe',
  headless: 'project-safe',
  restart: 'project-safe',
  noRecord: 'project-safe',
  record: 'project-safe',
  recordAs: 'project-safe',
  saveScript: 'project-safe',
  snapshotInteractiveOnly: 'project-safe',
  snapshotDiff: 'project-safe',
  snapshotDepth: 'project-safe',
  snapshotScope: 'project-safe',
  snapshotRaw: 'project-safe',
  snapshotForceFull: 'project-safe',
  screenshotPixelDensity: 'project-safe',
  screenshotFullscreen: 'project-safe',
  screenshotMaxSize: 'project-safe',
  screenshotNoStabilize: 'project-safe',
  screenshotNormalizeStatusBar: 'project-safe',
  overlayRefs: 'project-safe',
  networkInclude: 'project-safe',
  baseline: 'project-safe',
  threshold: 'project-safe',
  count: 'project-safe',
  pointerCount: 'project-safe',
  fps: 'project-safe',
  quality: 'project-safe',
  hideTouches: 'project-safe',
  recordingScope: 'project-safe',
  intervalMs: 'project-safe',
  delayMs: 'project-safe',
  durationMs: 'project-safe',
  holdMs: 'project-safe',
  jitterPx: 'project-safe',
  pixels: 'project-safe',
  doubleTap: 'project-safe',
  verify: 'project-safe',
  settle: 'project-safe',
  settleQuietMs: 'project-safe',
  clickButton: 'project-safe',
  backMode: 'project-safe',
  pauseMs: 'project-safe',
  pattern: 'project-safe',
  kind: 'project-safe',
  perfTemplate: 'project-safe',
  responseLevel: 'project-safe',
  verbose: 'project-safe',
  cost: 'project-safe',
  timeoutMs: 'project-safe',
  retries: 'project-safe',
  failFast: 'project-safe',
  recordVideo: 'project-safe',
  replayUpdate: 'project-safe',
  replayMaestro: 'project-safe',
  replayFrom: 'project-safe',
  replayPlanDigest: 'project-safe',
  replayKeepSession: 'project-safe',
  findFirst: 'project-safe',
  findLast: 'project-safe',
  batchOnError: 'project-safe',
  batchMaxSteps: 'project-safe',
  retainPaths: 'project-safe',
  retentionMs: 'project-safe',
  reporter: 'project-safe',
  reportJunit: 'project-safe',
  shardAll: 'project-safe',
  shardSplit: 'project-safe',
  noLogin: 'project-safe',
} satisfies Record<FlagKey, ConfigTrust>;

function configTrustForFlag(key: FlagKey): ConfigTrust {
  return CONFIG_TRUST_BY_FLAG[key];
}

function primaryFlagDefinition(spec: OptionSpec): FlagDefinition {
  const definition = spec.flagDefinitions[0];
  if (!definition) {
    throw new Error(`Missing flag definition for option ${spec.key}`);
  }
  return definition;
}

export function resolveSourceValueDefinition(spec: OptionSpec): FlagDefinition {
  const explicitValueDefinition = spec.flagDefinitions.find(
    (definition) => definition.setValue === undefined,
  );
  if (explicitValueDefinition) return explicitValueDefinition;

  const baseDefinition = primaryFlagDefinition(spec);
  if (baseDefinition.type === 'enum') {
    const enumValues =
      baseDefinition.enumValues ??
      spec.flagDefinitions
        .map((definition) => definition.setValue)
        .filter((value): value is NonNullable<typeof value> => value !== undefined);
    return {
      ...baseDefinition,
      setValue: undefined,
      enumValues: enumValues as readonly string[],
    };
  }
  return baseDefinition;
}
