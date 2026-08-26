import type { BatchRunOptions } from '@agent-device/contracts/client';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonToClientOptions } from '../command-input.ts';
import { batchCliOutputFormatters } from './output.ts';
import { createBatchCommandMetadata, type BatchInput } from './metadata.ts';
import { STRUCTURED_BATCH_COMMAND_NAMES } from '../../core/batch-policy.ts';
import { createBatchDaemonWriter } from './projection.ts';

const batchCommandMetadata = createBatchCommandMetadata();

const batchCommandDefinition = defineExecutableCommand(batchCommandMetadata, (client, input) =>
  client.batch.run(toBatchOptions(input)),
);

const batchCliSchema = {
  usageOverride: 'batch [--steps <json> | --steps-file <path>]',
  listUsageOverride: 'batch --steps <json> | --steps-file <path>',
  allowedFlags: ['steps', 'stepsFile', 'batchOnError', 'batchMaxSteps', 'out'],
} as const satisfies CommandSchemaOverride;

const batchCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  steps: flags.batchSteps ?? [],
  onError: flags.batchOnError,
  maxSteps: flags.batchMaxSteps,
  out: flags.out,
});

/**
 * `help batch` documented neither the step shape nor which commands batch accepts, so an agent
 * discovered both by trial: `["press @e12"]` and `{"command":"press","args":[...]}` were refused
 * without either being named (#2062). The accepted set is RENDERED from the command-descriptor
 * registry's `batchable` trait, so it cannot drift from what the runtime allowlist enforces.
 */
function buildBatchCliDetail(): string {
  return [
    'Each step is {"command":"<name>","input":{...}}: the same input object that command takes on its own — run agent-device help <command> for its arguments. There is no positional step form; args, target, and argv are not step fields.',
    'Steps run serially in one daemon request against the same session, in order. Mutating UI verbs are included (press, click, fill, longpress, scroll, back), which is where the round-trip saving is; --on-error stop halts at the first failing step.',
    `Available through batch: ${[...STRUCTURED_BATCH_COMMAND_NAMES].sort().join(', ')}.`,
    'Every other command is excluded: batch and replay never nest, and session, daemon, connection, and host tooling commands own lifecycle a batch request cannot carry. Run those on their own.',
  ].join(' ');
}

const batchCommandFacet = defineCommandFacet({
  name: 'batch',
  text: {
    summary: 'Run multiple commands',
    cliDetail: buildBatchCliDetail(),
  },
  metadata: batchCommandMetadata,
  definition: batchCommandDefinition,
  cliSchema: batchCliSchema,
  cliReader: batchCliReader,
  cliOutputFormatter: batchCliOutputFormatters.batch,
});

export const batchCommandFamily = defineCommandFamilyFromFacets({
  name: 'batch',
  clientSurface: false,
  commands: [batchCommandFacet],
});

export { createBatchDaemonWriter };

function toBatchOptions(input: BatchInput): BatchRunOptions {
  return {
    ...commonToClientOptions(input),
    steps: input.steps,
    onError: input.onError,
    maxSteps: input.maxSteps,
    out: input.out,
  };
}
