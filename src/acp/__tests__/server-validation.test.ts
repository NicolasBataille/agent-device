import assert from 'node:assert/strict';
import { setImmediate as flushEventLoop } from 'node:timers/promises';
import { test } from 'vitest';
import { createMcpPayloadQueue, McpMessageDecoder } from '../../mcp/server.ts';
import { createAcpRouter } from '../router.ts';
import { createAcpPayloadSink } from '../server.ts';

function makeQueueHarness() {
  const written: unknown[] = [];
  const router = createAcpRouter({
    sendNotification: (message) => written.push(message),
    scheduleAfterResponse: (run) => run(),
  });
  const queue = createMcpPayloadQueue({
    handlePayload: router.handleAcpPayload,
    write: (message) => written.push(message),
  });
  return { router, queue, written };
}

test('invalid JSON-RPC envelopes are rejected with -32600', async () => {
  const { queue, written } = makeQueueHarness();
  queue.push(42);
  queue.push([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]);
  await queue.idle();

  assert.equal(written.length, 2);
  for (const message of written) {
    assert.equal((message as { error: { code: number } }).error.code, -32600);
  }
});

test('the decoder rejects malformed JSON lines without emitting payloads', () => {
  const payloads: unknown[] = [];
  const decoder = new McpMessageDecoder((payload) => payloads.push(payload));
  assert.throws(() => decoder.push('{not json}\n'));
  assert.equal(payloads.length, 0);
});

test('session/cancel bypasses the serialized queue while a prompt holds it', async () => {
  const written: unknown[] = [];
  const cancelled: string[] = [];
  let releasePrompt: (() => void) | undefined;
  const blockingHandler = async (payload: unknown): Promise<unknown | null> => {
    const method = (payload as { method?: string }).method;
    if (method === 'session/prompt') {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { jsonrpc: '2.0', id: (payload as { id: number }).id, result: {} };
    }
    return null;
  };
  const queue = createMcpPayloadQueue({
    handlePayload: blockingHandler,
    write: (message) => written.push(message),
  });
  const sink = createAcpPayloadSink(
    { markSessionCancelled: (payload) => cancelled.push(JSON.stringify(payload)) },
    queue.push,
  );

  sink({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's' } });
  // Let the queue start the prompt handler so it is genuinely holding the queue.
  await flushEventLoop();
  sink({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });

  assert.equal(cancelled.length, 1, 'cancel notification must not wait behind the queue');
  assert.equal(written.length, 0);
  assert.ok(releasePrompt, 'prompt handler should be running');
  releasePrompt?.();
  await queue.idle();
  assert.equal(written.length, 1);
});

test('a session/cancel request with an id is not intercepted as a notification', () => {
  const pushed: unknown[] = [];
  const cancelled: unknown[] = [];
  const sink = createAcpPayloadSink(
    { markSessionCancelled: (payload) => cancelled.push(payload) },
    (payload) => pushed.push(payload),
  );

  sink({ jsonrpc: '2.0', id: 7, method: 'session/cancel', params: { sessionId: 's' } });

  assert.equal(cancelled.length, 0);
  assert.equal(pushed.length, 1);
});
