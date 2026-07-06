import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listMcpExposedCommandNames } from '../../core/command-descriptor/registry.ts';
import type { AcpToolKind } from '../contracts.ts';
import { toolKindForCommand } from '../tool-kinds.ts';

const VALID_TOOL_KINDS: ReadonlySet<AcpToolKind> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

test('every ACP-runnable command maps to a valid ACP tool kind', () => {
  for (const command of listMcpExposedCommandNames()) {
    const kind = toolKindForCommand(command);
    assert.ok(VALID_TOOL_KINDS.has(kind), `command ${command} mapped to invalid tool kind ${kind}`);
  }
});

test('tool kinds distinguish reads from actions for representative commands', () => {
  assert.equal(toolKindForCommand('snapshot'), 'read');
  assert.equal(toolKindForCommand('screenshot'), 'read');
  assert.equal(toolKindForCommand('devices'), 'read');
  assert.equal(toolKindForCommand('find'), 'search');
  assert.equal(toolKindForCommand('press'), 'execute');
  assert.equal(toolKindForCommand('open'), 'execute');
  assert.equal(toolKindForCommand('install'), 'execute');
});
