import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { getDaemonRouteOwnerFiles, runRequestHandlerChain } from '../request-handler-chain.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { makeIosSession } from '../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

function makeRequest(command: string, positionals: string[] = []): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: 'chain-test',
    positionals,
    flags: {},
    meta: { requestId: `req-${command}` },
  };
}

function makeChainParams(req: DaemonRequest) {
  const sessionStore = makeSessionStore('agent-device-request-chain-');
  sessionStore.set('chain-test', makeIosSession('chain-test'));
  return {
    req,
    sessionName: 'chain-test',
    logPath: '/tmp/agent-device-request-chain.log',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    contextFromFlags: () => ({ logPath: '/tmp/agent-device-request-chain.log' }),
  };
}

function getOwnerBlock(source: string): string {
  const match = source.match(
    /const DAEMON_ROUTE_OWNER_FILES = \{\s*([\s\S]*?)\s*\} as const satisfies Record<DaemonCommandRoute, string>;/s,
  );
  assert.ok(match?.[1]);
  return match[1];
}

function getHandlersBlock(source: string): string {
  const match = source.match(/const DAEMON_ROUTE_HANDLERS = \{\s*([\s\S]*?)\s*\} as const;/s);
  assert.ok(match?.[1]);
  return match[1];
}

function getGenericModulePath(source: string): string {
  const match = /import \* as genericRequestHandlerModule from '([^']+)'/.exec(source);
  assert.ok(match?.[1]);
  return match[1];
}

function parseOwnerRecord(block: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [, route, ownerFile] of block.matchAll(/(\w+): '([^']+)',/g)) {
    assert.ok(route && ownerFile);
    record[route] = ownerFile;
  }
  return record;
}

function parseHandlerModulePaths(block: string): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [, route, modulePath] of block.matchAll(
    /(\w+): defineDaemonRoute\(\{\s+load: \(\) => import\('([^']+)'\),/g,
  )) {
    assert.ok(route && modulePath);
    paths[route] = modulePath;
  }
  return paths;
}

function assertGenericOwnerFile(
  ownerFiles: Record<string, string>,
  genericModulePath: string,
  genericOwnerFile: string | undefined,
): void {
  assert.ok(genericOwnerFile);
  assert.equal(genericOwnerFile, `src/daemon/${genericModulePath.slice(2)}`);
  assert.equal(ownerFiles.generic, genericOwnerFile);
}

test('route owner files match the production module loaders', () => {
  const source = fs.readFileSync(new URL('../request-handler-chain.ts', import.meta.url), 'utf8');
  const ownerFiles = getDaemonRouteOwnerFiles();
  const ownerBlock = getOwnerBlock(source);
  const ownerRecord = parseOwnerRecord(ownerBlock);
  const handlerPaths = parseHandlerModulePaths(getHandlersBlock(source));
  const genericModulePath = getGenericModulePath(source);

  assert.equal(Object.keys(ownerRecord).length, Object.keys(ownerFiles).length);

  for (const [route, ownerFile] of Object.entries(ownerRecord)) {
    assert.equal(ownerFiles[route as keyof typeof ownerFiles], ownerFile);
  }

  for (const [route, modulePath] of Object.entries(handlerPaths)) {
    assert.equal(ownerFiles[route as keyof typeof ownerFiles], `src/daemon/${modulePath.slice(2)}`);
  }

  assertGenericOwnerFile(ownerFiles, genericModulePath, ownerRecord.generic);
});

test('request handler chain routes trace commands to the record-trace family', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('trace', ['start'])));

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.trace, 'started');
});

test('request handler chain leaves generic commands for fallback dispatch', async () => {
  for (const command of ['back', 'gesture', 'home', 'screenshot', 'scroll', 'swipe']) {
    const response = await runRequestHandlerChain(makeChainParams(makeRequest(command)));

    assert.equal(response, null, `${command} should fall through to generic dispatch`);
  }
});

test('request handler chain routes lease commands to the lease family', async () => {
  const response = await runRequestHandlerChain({
    ...makeChainParams({
      ...makeRequest(INTERNAL_COMMANDS.leaseAllocate),
      flags: { tenant: 'tenant-a', runId: 'run-a' },
    }),
    sessionName: 'other-session',
  });

  assert.equal(response?.ok, true);
  assert.equal(typeof response?.data?.lease, 'object');
});

test('request handler chain routes session commands to the session family', async () => {
  const response = await runRequestHandlerChain(
    makeChainParams(makeRequest(INTERNAL_COMMANDS.runtime, ['show'])),
  );

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.session, 'chain-test');
  assert.equal(response?.data?.configured, false);
});
