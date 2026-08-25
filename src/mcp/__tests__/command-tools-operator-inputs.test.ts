import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

// Operator-owned inputs are never model-writable: the model reads untrusted
// app UI text and picks tool arguments, so no tool schema may offer a
// parameter to write a credential, the endpoint it is sent to, or an
// operator infrastructure path into (exfiltration/redirect path). The keys
// are refused as explicit input too — fail closed with env guidance, the
// same posture as retired fields — while operator env/config defaults keep
// flowing outside the model-writable surface.
const OPERATOR_OWNED_KEYS = [
  'daemonAuthToken',
  'bearerToken',
  'daemonBaseUrl',
  'proxyBaseUrl',
  'stateDir',
  'cwd',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
] as const;

test('MCP tool schemas advertise no operator-owned inputs', () => {
  for (const tool of listCommandTools()) {
    const properties = tool.inputSchema.properties ?? {};
    for (const key of OPERATOR_OWNED_KEYS) {
      assert.equal(key in properties, false, `${tool.name} advertises ${key}`);
    }
  }
});

test('MCP refuses every explicit operator-owned argument with guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  for (const key of OPERATOR_OWNED_KEYS) {
    const result = await executor.execute('wait', { [key]: '/steered/by/screen-text' });
    assert.equal(result.isError, true, `${key} must be refused`);
    assert.match(
      result.content[0]?.text ?? '',
      new RegExp(`${key} is not accepted as a tool argument`),
    );
  }
  assert.deepEqual(calls, [], 'a refused operator input must never reach the command route');
});

test('MCP refuses an explicit daemonAuthToken argument with env guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  const result = await executor.execute('wait', { daemonAuthToken: 'stolen-token' });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /daemonAuthToken is not accepted as a tool argument/);
  assert.match(result.content[0]?.text ?? '', /AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
  assert.deepEqual(calls, [], 'a refused credential input must never reach the command route');
});

test('MCP refuses an explicit metro bearerToken argument with env guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  const result = await executor.execute('metro', {
    action: 'prepare',
    bearerToken: 'stolen-token',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /bearerToken is not accepted as a tool argument/);
  assert.match(result.content[0]?.text ?? '', /AGENT_DEVICE_METRO_BEARER_TOKEN/);
  assert.deepEqual(calls, [], 'a refused credential input must never reach the command route');
});

// The refusal covers the model-writable surface only: operator values from
// the environment must still merge as config-backed defaults and reach the
// command route (or the MCP client config, for stateDir) unchanged.
test('MCP still resolves operator env values outside the model-writable surface', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'operator-env-token');
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/operator/state-dir');
  try {
    const createdConfigs: Array<Record<string, unknown>> = [];
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executor = createCommandToolExecutor({
      createClient: (config) => {
        createdConfigs.push(config as Record<string, unknown>);
        return {} as AgentDeviceClient;
      },
      runCommand: async (_client, name, input) => {
        calls.push({ name, input: input as Record<string, unknown> });
        return {};
      },
    });

    const result = await executor.execute('wait', {});

    assert.equal(result.isError, false);
    assert.equal(calls[0]?.input.daemonAuthToken, 'operator-env-token');
    assert.equal(createdConfigs[0]?.stateDir, '/operator/state-dir');
  } finally {
    vi.unstubAllEnvs();
  }
});
