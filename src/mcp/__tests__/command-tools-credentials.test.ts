import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

// Credential inputs are operator-owned, never model-writable: the model reads
// untrusted app UI text and picks tool arguments, so no tool schema may offer
// a parameter to write a token into (exfiltration/auth-redirect path). The
// keys are refused as explicit input too — fail closed with env guidance, the
// same posture as retired fields — while operator env/config defaults keep
// flowing outside the model-writable surface.
test('MCP tool schemas advertise no credential inputs', () => {
  for (const tool of listCommandTools()) {
    const properties = tool.inputSchema.properties ?? {};
    assert.equal('daemonAuthToken' in properties, false, `${tool.name} advertises daemonAuthToken`);
    assert.equal('bearerToken' in properties, false, `${tool.name} advertises bearerToken`);
  }
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

// The refusal covers the model-writable surface only: an operator token from
// the environment must still merge as a config-backed default and reach the
// command route unchanged.
test('MCP still resolves the operator daemon auth token from the environment', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'operator-env-token');
  try {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executor = createCommandToolExecutor({
      createClient: () => ({}) as AgentDeviceClient,
      runCommand: async (_client, name, input) => {
        calls.push({ name, input: input as Record<string, unknown> });
        return {};
      },
    });

    const result = await executor.execute('wait', {});

    assert.equal(result.isError, false);
    assert.equal(calls[0]?.input.daemonAuthToken, 'operator-env-token');
  } finally {
    vi.unstubAllEnvs();
  }
});
