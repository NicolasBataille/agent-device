import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { RequestProgressSink } from '../../daemon/request-progress.ts';
import { AppError } from '../../kernel/errors.ts';
import type { AcpSessionUpdate } from '../contracts.ts';
import { createPromptRunner, type PromptRunnerDeps } from '../prompt-runner.ts';
import type { AcpSessionState } from '../session-state.ts';

const FAKE_CLIENT = {} as AgentDeviceClient;

function makeSession(sticky = {}): AcpSessionState {
  return {
    id: 'sess-1',
    cwd: tmpdir(),
    sticky,
    cancelled: false,
    promptActive: true,
    toolCallCounter: 0,
  };
}

function collectUpdates(): {
  updates: AcpSessionUpdate[];
  sendUpdate: (u: AcpSessionUpdate) => void;
} {
  const updates: AcpSessionUpdate[] = [];
  return { updates, sendUpdate: (update) => updates.push(update) };
}

function runnerWith(deps: Partial<PromptRunnerDeps>) {
  return createPromptRunner({
    createClient: async () => FAKE_CLIENT,
    readImageFile: () => undefined,
    ...deps,
  });
}

test('runs each prompt line as a tool call and summarizes the turn', async () => {
  const executed: string[] = [];
  const runner = runnerWith({
    runCommandLine: async ({ command }) => {
      executed.push(command);
      return { result: { ok: true }, cliOutput: { data: {}, text: `${command} done` } };
    },
  });
  const { updates, sendUpdate } = collectUpdates();

  const stopReason = await runner.runPrompt({
    session: makeSession(),
    promptText: 'devices\nsnapshot -i',
    sendUpdate,
  });

  assert.equal(stopReason, 'end_turn');
  assert.deepEqual(executed, ['devices', 'snapshot']);
  const kinds = updates.map((update) => update.sessionUpdate);
  assert.deepEqual(kinds, [
    'tool_call',
    'tool_call_update',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  const firstCall = updates[0] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>;
  assert.equal(firstCall.title, 'devices');
  assert.equal(firstCall.status, 'in_progress');
  assert.equal(firstCall.kind, 'read');
  const firstDone = updates[1] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>;
  assert.equal(firstDone.toolCallId, firstCall.toolCallId);
  assert.equal(firstDone.status, 'completed');
  assert.deepEqual(firstDone.rawOutput, { ok: true });
  assert.match(JSON.stringify(firstDone.content), /devices done/);
  const summary = updates.at(-1) as Extract<
    AcpSessionUpdate,
    { sessionUpdate: 'agent_message_chunk' }
  >;
  assert.match(summary.content.type === 'text' ? summary.content.text : '', /✓ devices/);
});

test('command failures become failed tool calls with the full error contract', async () => {
  const runner = runnerWith({
    runCommandLine: async () => {
      throw new AppError('DEVICE_NOT_FOUND', 'No booted device.', { hint: 'Boot one first.' });
    },
  });
  const { updates, sendUpdate } = collectUpdates();

  const stopReason = await runner.runPrompt({
    session: makeSession(),
    promptText: 'devices',
    sendUpdate,
  });

  assert.equal(stopReason, 'end_turn');
  const failed = updates[1] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>;
  assert.equal(failed.status, 'failed');
  const text = JSON.stringify(failed.content);
  assert.match(text, /Error \(DEVICE_NOT_FOUND\): No booted device\./);
  assert.match(text, /Hint: Boot one first\./);
});

test('prompts with no runnable command lines are refused without touching the daemon', async () => {
  let clientCreated = false;
  const runner = runnerWith({
    createClient: async () => {
      clientCreated = true;
      return FAKE_CLIENT;
    },
    runCommandLine: async () => {
      throw new Error('must not run');
    },
  });
  const { updates, sendUpdate } = collectUpdates();

  const stopReason = await runner.runPrompt({
    session: makeSession(),
    promptText: 'please tap the login button',
    sendUpdate,
  });

  assert.equal(stopReason, 'refusal');
  assert.equal(clientCreated, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.sessionUpdate, 'agent_message_chunk');
});

test('unparseable lines fail individually while runnable lines still execute', async () => {
  const executed: string[] = [];
  const runner = runnerWith({
    runCommandLine: async ({ command }) => {
      executed.push(command);
      return { result: {}, cliOutput: { data: {}, text: 'ok' } };
    },
  });
  const { updates, sendUpdate } = collectUpdates();

  const stopReason = await runner.runPrompt({
    session: makeSession(),
    promptText: 'frobnicate\ndevices',
    sendUpdate,
  });

  assert.equal(stopReason, 'end_turn');
  assert.deepEqual(executed, ['devices']);
  const failedCall = updates[0] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>;
  assert.equal(failedCall.status, 'in_progress');
  const failedUpdate = updates[1] as Extract<
    AcpSessionUpdate,
    { sessionUpdate: 'tool_call_update' }
  >;
  assert.equal(failedUpdate.toolCallId, failedCall.toolCallId);
  assert.equal(failedUpdate.status, 'failed');
  assert.match(JSON.stringify(failedUpdate.content), /Unknown command: frobnicate/);
});

test('sticky flags from one line carry into later lines of the same session', async () => {
  const platforms: Array<string | undefined> = [];
  const session = makeSession();
  const runner = runnerWith({
    runCommandLine: async ({ flags }) => {
      platforms.push(flags.platform);
      return { result: {}, cliOutput: { data: {}, text: 'ok' } };
    },
  });
  const { sendUpdate } = collectUpdates();

  await runner.runPrompt({
    session,
    promptText: 'apps --platform ios\nsnapshot -i',
    sendUpdate,
  });

  assert.deepEqual(platforms, ['ios', 'ios']);
  assert.equal(session.sticky.platform, 'ios');
});

test('cancellation between lines stops the turn with the cancelled stop reason', async () => {
  const session = makeSession();
  const executed: string[] = [];
  const runner = runnerWith({
    runCommandLine: async ({ command }) => {
      executed.push(command);
      session.cancelled = true;
      return { result: {}, cliOutput: { data: {}, text: 'ok' } };
    },
  });
  const { sendUpdate } = collectUpdates();

  const stopReason = await runner.runPrompt({
    session,
    promptText: 'devices\nsnapshot -i',
    sendUpdate,
  });

  assert.equal(stopReason, 'cancelled');
  assert.deepEqual(executed, ['devices']);
});

test('screenshot results attach an inline image when the artifact is readable', async () => {
  const runner = runnerWith({
    runCommandLine: async () => ({
      result: { path: '/artifacts/screen.png' },
      cliOutput: { data: {}, text: 'Saved screenshot' },
    }),
    readImageFile: (path) =>
      path === '/artifacts/screen.png'
        ? { type: 'image', data: 'aGk=', mimeType: 'image/png' }
        : undefined,
  });
  const { updates, sendUpdate } = collectUpdates();

  await runner.runPrompt({ session: makeSession(), promptText: 'screenshot', sendUpdate });

  const done = updates[1] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>;
  assert.equal(done.status, 'completed');
  const image = done.content?.find((entry) => entry.content.type === 'image');
  assert.ok(image, 'expected an inline image content block');
});

test('large ref-issuing command results omit rawOutput from completed tool updates', async () => {
  const rawOutputs: unknown[] = [];
  const runner = runnerWith({
    runCommandLine: async ({ command }) => ({
      result:
        command === 'snapshot'
          ? { nodes: [{ ref: 'e1', label: 'Checkout' }], refsGeneration: 7 }
          : { ref: '@e1', label: 'Checkout', refsGeneration: 7 },
      cliOutput: { data: {}, text: `${command} done` },
    }),
  });
  const { updates, sendUpdate } = collectUpdates();

  await runner.runPrompt({
    session: makeSession(),
    promptText: 'snapshot -i\nfind Checkout',
    sendUpdate,
  });

  for (const update of updates) {
    if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
      rawOutputs.push(update.rawOutput);
    }
  }
  assert.deepEqual(rawOutputs, [undefined, undefined]);
});

test('daemon progress events stream as in_progress tool call updates', async () => {
  let progressSink: RequestProgressSink | undefined;
  const runner = runnerWith({
    createClient: async (_config, onProgress) => {
      progressSink = onProgress;
      return FAKE_CLIENT;
    },
    runCommandLine: async () => {
      progressSink?.({ type: 'command', status: 'progress', message: 'Booting simulator…' });
      return { result: {}, cliOutput: { data: {}, text: 'ok' } };
    },
  });
  const { updates, sendUpdate } = collectUpdates();

  await runner.runPrompt({ session: makeSession(), promptText: 'boot', sendUpdate });

  const progress = updates[1] as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>;
  assert.equal(progress.status, 'in_progress');
  assert.match(JSON.stringify(progress.content), /Booting simulator…/);
});
