import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function source(path: string): string {
  return fs.readFileSync(`${REPO_ROOT}${path}`, 'utf8');
}

function hostRouteDefects(
  routeSource: string,
  serviceMember: string,
  forbiddenPlatformSpecifier: string,
): string[] {
  const defects: string[] = [];
  if (!routeSource.includes(serviceMember)) defects.push(`missing ${serviceMember}`);
  if (routeSource.includes(forbiddenPlatformSpecifier)) {
    defects.push(`direct platform import ${forbiddenPlatformSpecifier}`);
  }
  return defects;
}

function replayDelegationDefects(replaySource: string, dispatchSource: string): string[] {
  const defects: string[] = [];
  if (!replaySource.includes("positionals: ['gesture-viewport']")) {
    defects.push('Maestro viewport does not delegate to runtime gesture-viewport');
  }
  if (replaySource.includes('dispatchGestureViewport')) {
    defects.push('Maestro viewport still calls the legacy interactor dispatcher');
  }
  if (dispatchSource.includes('dispatchGestureViewport')) {
    defects.push('legacy gesture viewport dispatcher remains exported');
  }
  return defects;
}

describe('host and replay residue execution ownership', () => {
  test('only perf remains legacy', () => {
    expect(
      commandDescriptors
        .filter(({ platformExecution }) => platformExecution.kind === 'legacy')
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['perf']);
  });

  test('daemon and web declare host execution through their neutral services', () => {
    expect(commandDescriptors.find(({ name }) => name === 'daemon')?.platformExecution.kind).toBe(
      'host',
    );
    expect(commandDescriptors.find(({ name }) => name === 'web')?.platformExecution.kind).toBe(
      'host',
    );
    expect(
      hostRouteDefects(
        source('src/cli/commands/daemon.ts'),
        'daemonOwnerCleanup.cleanup(',
        'platforms/apple/',
      ),
    ).toEqual([]);
    expect(
      hostRouteDefects(source('src/cli/commands/web.ts'), 'managedWebBackend.', 'platforms/web/'),
    ).toEqual([]);
  });

  test('planted red: a host route importing its platform implementation is rejected', () => {
    expect(
      hostRouteDefects(
        "import '../../platforms/apple/core/runner-client.ts'; daemonOwnerCleanup.cleanup(owner);",
        'daemonOwnerCleanup.cleanup(',
        'platforms/apple/',
      ),
    ).toEqual(['direct platform import platforms/apple/']);
  });

  test('replay and test own orchestration while runtime owns Maestro viewport execution', () => {
    expect(commandDescriptors.find(({ name }) => name === 'replay')?.platformExecution.kind).toBe(
      'none',
    );
    expect(commandDescriptors.find(({ name }) => name === 'test')?.platformExecution.kind).toBe(
      'none',
    );
    expect(
      replayDelegationDefects(
        source('src/daemon/handlers/session-replay-maestro-runtime.ts'),
        source('src/core/dispatch.ts'),
      ),
    ).toEqual([]);
  });

  test('planted red: a replay route restoring the direct viewport helper is rejected', () => {
    expect(replayDelegationDefects('dispatchGestureViewport(device)', '')).toEqual([
      'Maestro viewport does not delegate to runtime gesture-viewport',
      'Maestro viewport still calls the legacy interactor dispatcher',
    ]);
  });
});
