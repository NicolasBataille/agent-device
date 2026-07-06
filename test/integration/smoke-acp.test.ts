import test from 'node:test';
import assert from 'node:assert/strict';
import { runCmdBackground } from '../../src/utils/exec.ts';

type JsonLine = Record<string, unknown>;

const RESPONSE_TIMEOUT_MS = 30_000;

function startAcpServer() {
  const { child, wait } = runCmdBackground(
    process.execPath,
    ['--experimental-strip-types', 'src/bin.ts', 'acp'],
    { stdio: ['pipe', 'pipe', 'pipe'], captureOutput: false },
  );
  const lines: JsonLine[] = [];
  const waiters: Array<{
    predicate: (line: JsonLine) => boolean;
    resolve: (line: JsonLine) => void;
  }> = [];
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (raw.length === 0) continue;
      const line = JSON.parse(raw) as JsonLine;
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.predicate(line)) {
          const [waiter] = waiters.splice(i, 1);
          waiter!.resolve(line);
        }
      }
    }
  });

  return {
    child,
    wait,
    lines,
    send: (message: JsonLine) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    waitFor: (label: string, predicate: (line: JsonLine) => boolean): Promise<JsonLine> => {
      const existing = lines.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          RESPONSE_TIMEOUT_MS,
        );
        waiters.push({
          predicate,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

function isSessionUpdate(line: JsonLine, sessionUpdate: string): boolean {
  if (line.method !== 'session/update') return false;
  const update = (line.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
  return update?.sessionUpdate === sessionUpdate;
}

test('acp stdio agent serves initialize, session/new, prompt refusal, and clean shutdown', async () => {
  const server = startAcpServer();
  try {
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const initialize = await server.waitFor('initialize response', (line) => line.id === 1);
    const initResult = initialize.result as {
      protocolVersion: number;
      authMethods: unknown[];
      agentInfo: { name: string };
    };
    assert.equal(initResult.protocolVersion, 1);
    assert.deepEqual(initResult.authMethods, []);
    assert.equal(initResult.agentInfo.name, 'agent-device');

    server.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    });
    const newSession = await server.waitFor('session/new response', (line) => line.id === 2);
    const sessionId = (newSession.result as { sessionId: string }).sessionId;
    assert.ok(sessionId.length > 0);

    const commandsUpdate = await server.waitFor('available_commands_update', (line) =>
      isSessionUpdate(line, 'available_commands_update'),
    );
    const commands = (
      commandsUpdate.params as {
        update: { availableCommands: Array<{ name: string; description: string }> };
      }
    ).update.availableCommands.map((command) => command.name);
    assert.ok(commands.includes('snapshot'));
    assert.ok(commands.includes('press'));
    assert.ok(!commands.includes('acp'));
    // The session/new response must have been written before the notification.
    assert.ok(
      server.lines.indexOf(newSession) < server.lines.indexOf(commandsUpdate),
      'available_commands_update arrived before the session/new response',
    );

    // An unrunnable prompt is refused deterministically without a daemon/device.
    server.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'frobnicate' }] },
    });
    const prompt = await server.waitFor('session/prompt response', (line) => line.id === 3);
    assert.deepEqual(prompt.result, { stopReason: 'refusal' });
    await server.waitFor('refusal agent message', (line) =>
      isSessionUpdate(line, 'agent_message_chunk'),
    );

    server.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId: 'unknown-session', prompt: [{ type: 'text', text: 'devices' }] },
    });
    const unknownSession = await server.waitFor('unknown session error', (line) => line.id === 4);
    assert.equal((unknownSession.error as { code: number }).code, -32602);

    server.child.stdin?.end();
    const exit = await server.wait;
    assert.equal(exit.exitCode, 0);
  } finally {
    if (server.child.exitCode === null) server.child.kill();
  }
});
