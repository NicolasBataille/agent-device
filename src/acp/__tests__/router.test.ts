import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listMcpExposedCommandNames } from '../../core/command-descriptor/registry.ts';
import type { AcpStopReason } from '../contracts.ts';
import type { PromptRunner } from '../prompt-runner.ts';
import { createAcpRouter } from '../router.ts';

type RouterHarness = {
  router: ReturnType<typeof createAcpRouter>;
  written: unknown[];
  scheduled: Array<() => void>;
  flushScheduled: () => void;
};

function makeRouter(promptRunner?: PromptRunner): RouterHarness {
  const written: unknown[] = [];
  const scheduled: Array<() => void> = [];
  const router = createAcpRouter({
    sendNotification: (message) => written.push(message),
    promptRunner,
    scheduleAfterResponse: (run) => scheduled.push(run),
  });
  return {
    router,
    written,
    scheduled,
    flushScheduled: () => {
      while (scheduled.length > 0) scheduled.shift()!();
    },
  };
}

function stubRunner(run: PromptRunner['runPrompt']): PromptRunner {
  return { runPrompt: run };
}

async function newSessionId(harness: RouterHarness): Promise<string> {
  const response = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp', mcpServers: [] },
  })) as { result: { sessionId: string } };
  return response.result.sessionId;
}

test('initialize advertises ACP v1 with no auth and text-only prompts', async () => {
  const { router } = makeRouter();
  const response = (await router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  })) as { result: Record<string, unknown> };

  assert.equal(response.result.protocolVersion, 1);
  assert.deepEqual(response.result.authMethods, []);
  assert.deepEqual(response.result.agentCapabilities, {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  });
  const agentInfo = response.result.agentInfo as { name: string; version: string };
  assert.equal(agentInfo.name, 'agent-device');
  assert.match(agentInfo.version, /^\d+\.\d+\.\d+/);
});

test('session/new returns a sessionId before advertising available commands', async () => {
  const harness = makeRouter();
  const sessionId = await newSessionId(harness);

  assert.ok(sessionId.length > 0);
  // The available_commands_update must not be written before the response.
  assert.equal(harness.written.length, 0);
  harness.flushScheduled();
  assert.equal(harness.written.length, 1);
  const notification = harness.written[0] as {
    method: string;
    params: {
      sessionId: string;
      update: { sessionUpdate: string; availableCommands: Array<{ name: string }> };
    };
  };
  assert.equal(notification.method, 'session/update');
  assert.equal(notification.params.sessionId, sessionId);
  assert.equal(notification.params.update.sessionUpdate, 'available_commands_update');
  assert.deepEqual(
    notification.params.update.availableCommands.map((command) => command.name).sort(),
    listMcpExposedCommandNames().sort(),
  );
});

test('session/prompt forwards updates for the session and returns the stop reason', async () => {
  const harness = makeRouter(
    stubRunner(async ({ promptText, sendUpdate }) => {
      assert.equal(promptText, 'devices\nsnapshot -i');
      sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
      return 'end_turn';
    }),
  );
  const sessionId = await newSessionId(harness);

  const response = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: {
      sessionId,
      prompt: [
        { type: 'text', text: 'devices' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'text', text: 'snapshot -i' },
      ],
    },
  })) as { result: { stopReason: AcpStopReason } };

  assert.equal(response.result.stopReason, 'end_turn');
  const update = harness.written.at(-1) as { params: { sessionId: string } };
  assert.equal(update.params.sessionId, sessionId);
});

test('a second prompt on a busy session is rejected with invalid params', async () => {
  let release: (() => void) | undefined;
  const harness = makeRouter(
    stubRunner(
      () =>
        new Promise<AcpStopReason>((resolve) => {
          release = () => resolve('end_turn');
        }),
    ),
  );
  const sessionId = await newSessionId(harness);

  const first = harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'devices' }] },
  });
  const second = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'devices' }] },
  })) as { error: { code: number } };

  assert.equal(second.error.code, -32602);
  release?.();
  await first;
});

test('session/cancel during a prompt turns the response into cancelled', async () => {
  const harness = makeRouter(
    stubRunner(async ({ session }) => {
      // Simulate the out-of-band cancel interception landing mid-turn.
      harness.router.markSessionCancelled({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: session.id },
      });
      return 'end_turn';
    }),
  );
  const sessionId = await newSessionId(harness);

  const response = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'devices' }] },
  })) as { result: { stopReason: AcpStopReason } };

  assert.equal(response.result.stopReason, 'cancelled');
});

test('unknown methods, unknown sessions, and bad params return JSON-RPC errors', async () => {
  const harness = makeRouter();

  const unknownMethod = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/load',
    params: {},
  })) as { error: { code: number } };
  assert.equal(unknownMethod.error.code, -32601);

  const missingCwd = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: {},
  })) as { error: { code: number } };
  assert.equal(missingCwd.error.code, -32602);

  const unknownSession = (await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'devices' }] },
  })) as { error: { code: number } };
  assert.equal(unknownSession.error.code, -32602);
});

test('session/new requires protocol-shaped session params', async () => {
  const harness = makeRouter();
  const cases: Array<{ name: string; params: unknown; message: RegExp }> = [
    { name: 'relative cwd', params: { cwd: 'relative', mcpServers: [] }, message: /absolute/ },
    { name: 'missing mcpServers', params: { cwd: '/tmp' }, message: /mcpServers/ },
    { name: 'non-array mcpServers', params: { cwd: '/tmp', mcpServers: {} }, message: /array/ },
    {
      name: 'non-object mcpServers entry',
      params: { cwd: '/tmp', mcpServers: [42] },
      message: /mcpServers\[0\]/,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const response = (await harness.router.handleAcpPayload({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'session/new',
      params: entry.params,
    })) as { error: { code: number; message: string } };
    assert.equal(response.error.code, -32602, entry.name);
    assert.match(response.error.message, entry.message, entry.name);
  }
});

test('notifications get no response and cancel notifications mark the session', async () => {
  let observedCancelled = false;
  const harness = makeRouter(
    stubRunner(async ({ session }) => {
      observedCancelled = session.cancelled;
      return session.cancelled ? 'cancelled' : 'end_turn';
    }),
  );
  const sessionId = await newSessionId(harness);

  const cancelResult = await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: { sessionId },
  });
  assert.equal(cancelResult, null);

  // A fresh prompt resets the cancel flag: the cancel above applied to no
  // active turn, and each session/prompt starts a new one.
  await harness.router.handleAcpPayload({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'devices' }] },
  });
  assert.equal(observedCancelled, false);
});
