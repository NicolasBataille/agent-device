import { expect, test } from 'vitest';
import { interactionCliReaders, interactionDaemonWriters } from './interactions.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';

const BASE_FLAGS: CliFlags = { json: false, help: false, version: false };

test('swipe writes only typed daemon input', () => {
  const request = interactionDaemonWriters.swipe({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });

  expect(request.positionals).toEqual([]);
  expect(request.input).toEqual({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });
});

test('scroll reader rejects a @ref in the direction slot with a grammar hint (#1366)', () => {
  try {
    interactionCliReaders.scroll(['@e29'], BASE_FLAGS);
    expect.unreachable('scroll should reject a ref where a direction is expected');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_ARGS');
    // The hint teaches the direction-first grammar and that scroll takes no target,
    // so the agent stops cycling `scroll @ref down` / `scroll down @ref`.
    expect(appError.details?.hint).toMatch(/direction first/i);
    expect(appError.details?.hint).toMatch(/no @ref or selector/i);
  }
});

test('fill projects recordAs through the typed daemon flags', () => {
  const request = interactionDaemonWriters.fill({
    selector: 'id="password"',
    text: 'live-secret',
    recordAs: 'PASSWORD',
  });

  expect(request.positionals).toEqual(['id="password"', 'live-secret']);
  expect(request.options.recordAs).toBe('PASSWORD');
});

// The empty text has to survive the CLI grammar AND the daemon projection for `fill @e57 ""` to
// reach the runner as a clear (#2063); a missing text argument must still read as missing, so the
// reader distinguishes "no text positional" from "an empty one".

test('fill reads an empty text positional as an empty text, not a missing one', () => {
  const input = interactionCliReaders.fill(['@e57', ''], BASE_FLAGS);

  expect(input.text).toBe('');
});

test('fill reads a missing text positional as undefined so required validation fires', () => {
  expect(interactionCliReaders.fill(['@e57'], BASE_FLAGS).text).toBeUndefined();
  expect(interactionCliReaders.fill(['label="Email"'], BASE_FLAGS).text).toBeUndefined();
  expect(interactionCliReaders.fill(['10', '20'], BASE_FLAGS).text).toBeUndefined();
});

test('fill projects an empty text as its own positional', () => {
  const request = interactionDaemonWriters.fill({ ref: '@e57', text: '' });

  expect(request.positionals).toEqual(['@e57', '']);
});
