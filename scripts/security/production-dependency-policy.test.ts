import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  productionDependencyPolicyIssues,
  type ProductionDependencyPolicyInput,
} from './production-dependency-policy.ts';

const validInput: ProductionDependencyPolicyInput = {
  limrunSpecifier: '0.24.5',
  bundledDependencies: ['@limrun/api'],
  nodeLinker: 'hoisted',
  undiciOverride: '^7.28.0',
  patchedDependencies: {
    '@limrun/api@0.24.5': 'patches/@limrun__api@0.24.5.patch',
  },
  installedLimrunVersion: '0.24.5',
  installedUndiciVersion: '7.28.0',
  limrunAndroidClientSource: [
    "import { execFile } from 'node:child_process';",
    "execFile(options.adbPath ?? 'adb', ['connect', serial], callback);",
  ].join('\n'),
  agentDeviceLimrunAndroidSource: [
    "const tunnel = await startTcpTunnel(session.adbUrl, session.token, '127.0.0.1', 0);",
    "await runCmd('adb', ['connect', serial]);",
  ].join('\n'),
};

describe('production dependency policy', () => {
  test('accepts the reviewed bundled Limrun tree', () => {
    assert.deepEqual(productionDependencyPolicyIssues(validInput), []);
  });

  test('rejects a vulnerable bundled undici version', () => {
    const issues = productionDependencyPolicyIssues({
      ...validInput,
      installedUndiciVersion: '7.24.7',
    });
    assert.ok(issues.some((issue) => issue.includes('Bundled undici')));
  });

  test('rejects a drifting Limrun range or missing matching patch', () => {
    const issues = productionDependencyPolicyIssues({
      ...validInput,
      limrunSpecifier: '^0.24.5',
      patchedDependencies: {},
    });
    assert.ok(issues.some((issue) => issue.includes('exact version')));
    assert.ok(issues.some((issue) => issue.includes('reviewed pnpm patch')));
  });

  test('rejects the shell-interpolated adb call', () => {
    const issues = productionDependencyPolicyIssues({
      ...validInput,
      limrunAndroidClientSource:
        "import { exec } from 'node:child_process';\nexec(`${options.adbPath} connect ${serial}`);",
    });
    assert.ok(issues.some((issue) => issue.includes('without shell interpolation')));
  });

  test('rejects delegation to Limrun’s shell-owning adb helper', () => {
    const issues = productionDependencyPolicyIssues({
      ...validInput,
      agentDeviceLimrunAndroidSource: 'await session.client.startAdbTunnel();',
    });
    assert.ok(issues.some((issue) => issue.includes('argument-safe adb connect')));
  });
});
