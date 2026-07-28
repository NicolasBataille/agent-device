export type ProductionDependencyPolicyInput = {
  limrunSpecifier: string | undefined;
  bundledDependencies: string[];
  nodeLinker: string | undefined;
  undiciOverride: string | undefined;
  patchedDependencies: Record<string, string>;
  installedLimrunVersion: string | undefined;
  installedUndiciVersion: string | undefined;
  limrunAndroidClientSource: string | undefined;
  agentDeviceLimrunAndroidSource: string | undefined;
};

const LIMRUN_PACKAGE = '@limrun/api';
const UNDICI_SAFE_FLOOR = '7.28.0';
const UNDICI_OVERRIDE = '^7.28.0';
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function productionDependencyPolicyIssues(input: ProductionDependencyPolicyInput): string[] {
  return POLICY_CHECKS.flatMap((check) => check(input));
}

type PolicyCheck = (input: ProductionDependencyPolicyInput) => string[];

const POLICY_CHECKS: PolicyCheck[] = [
  checkPinnedLimrun,
  checkBundledLimrun,
  checkHoistedLinker,
  checkUndiciOverride,
  checkInstalledLimrun,
  checkLimrunPatch,
  checkInstalledUndici,
  checkLimrunAndroidClient,
  checkAgentDeviceLimrunProvider,
];

function checkPinnedLimrun(input: ProductionDependencyPolicyInput): string[] {
  return input.limrunSpecifier && EXACT_VERSION_PATTERN.test(input.limrunSpecifier)
    ? []
    : ['@limrun/api must use an exact version so security patches cannot drift at pack time.'];
}

function checkBundledLimrun(input: ProductionDependencyPolicyInput): string[] {
  return input.bundledDependencies.includes(LIMRUN_PACKAGE)
    ? []
    : ['@limrun/api must be bundled so the patched transitive tree reaches npm consumers.'];
}

function checkHoistedLinker(input: ProductionDependencyPolicyInput): string[] {
  return input.nodeLinker === 'hoisted'
    ? []
    : ['pnpm nodeLinker must be hoisted for bundleDependencies to include the Limrun tree.'];
}

function checkUndiciOverride(input: ProductionDependencyPolicyInput): string[] {
  return input.undiciOverride === UNDICI_OVERRIDE
    ? []
    : [`undici@7 must be overridden to ${UNDICI_OVERRIDE}.`];
}

function checkInstalledLimrun(input: ProductionDependencyPolicyInput): string[] {
  return !input.limrunSpecifier || input.installedLimrunVersion === input.limrunSpecifier
    ? []
    : [
        `Installed @limrun/api ${input.installedLimrunVersion ?? 'is missing'}; expected ${input.limrunSpecifier}.`,
      ];
}

function checkLimrunPatch(input: ProductionDependencyPolicyInput): string[] {
  const limrunVersion = input.limrunSpecifier;
  const patchKey = limrunVersion ? `${LIMRUN_PACKAGE}@${limrunVersion}` : undefined;
  const expectedPatchPath = limrunVersion
    ? `patches/@limrun__api@${limrunVersion}.patch`
    : undefined;
  return patchKey && input.patchedDependencies[patchKey] === expectedPatchPath
    ? []
    : ['The pinned @limrun/api version must retain its reviewed pnpm patch.'];
}

function checkInstalledUndici(input: ProductionDependencyPolicyInput): string[] {
  const installedVersion = input.installedUndiciVersion;
  return installedVersion && isSameMajorAndAtLeast(installedVersion, UNDICI_SAFE_FLOOR)
    ? []
    : [
        `Bundled undici must be on patched major 7 at or above ${UNDICI_SAFE_FLOOR}; found ${
          installedVersion ?? 'nothing'
        }.`,
      ];
}

function checkLimrunAndroidClient(input: ProductionDependencyPolicyInput): string[] {
  const androidClient = input.limrunAndroidClientSource;
  const usesArgumentSafeExec =
    androidClient?.includes("import { execFile } from 'node:child_process';") &&
    androidClient.includes('execFile(options.adbPath') &&
    !androidClient.includes('exec(`${options.adbPath');
  return usesArgumentSafeExec
    ? []
    : ['The Limrun Android client must execute adb without shell interpolation.'];
}

function checkAgentDeviceLimrunProvider(input: ProductionDependencyPolicyInput): string[] {
  const providerSource = input.agentDeviceLimrunAndroidSource;
  const ownsArgumentSafeConnect =
    providerSource?.includes('startTcpTunnel(') &&
    providerSource.includes("runCmd('adb', ['connect', serial]") &&
    !providerSource.includes('client.startAdbTunnel(');
  return ownsArgumentSafeConnect
    ? []
    : ['The agent-device Limrun provider must own the argument-safe adb connect call.'];
}

function isSameMajorAndAtLeast(actual: string, floor: string): boolean {
  const actualParts = parseVersion(actual);
  const floorParts = parseVersion(floor);
  if (!actualParts || !floorParts || actualParts[0] !== floorParts[0]) return false;
  for (let index = 1; index < actualParts.length; index += 1) {
    if (actualParts[index] !== floorParts[index]) {
      return actualParts[index] > floorParts[index];
    }
  }
  return true;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
