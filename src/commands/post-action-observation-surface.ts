import type { PostActionObservationSupportFor } from '../core/command-descriptor/post-action-observation.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../core/command-descriptor/registry.ts';
import { SETTLE_FLAGS } from './cli-grammar/flag-groups.ts';
import type { FlagKey } from './cli-grammar/flag-types.ts';
import { booleanField, integerField } from './command-input.ts';

/**
 * The command-surface projection of the descriptor post-action observation
 * trait (src/core/command-descriptor/post-action-observation.ts): the CLI flags
 * a settle/verify-capable command accepts, and the input fields its MCP tool
 * and SDK options expose. Both derive from the trait map, so granting a command
 * `--settle` is one registry edit rather than a hunt through the per-family
 * grammar files.
 *
 * It lives outside `interaction/` because the trait is not an interaction-family
 * property: `back` (src/commands/system/index.ts) carries it too (#1638).
 */

const verifyField = () =>
  booleanField(
    'Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot.',
  );

const settleFields = () => ({
  settle: booleanField(
    'After the action, wait for the UI to go quiet and return the settled diff vs the pre-action tree in the same response. Best-effort; never fails the action.',
  ),
  settleQuietMs: integerField('Settle: quiet window in milliseconds (default 500).', { min: 0 }),
  timeoutMs: integerField('Settle: wait deadline in milliseconds (default 10000).', { min: 1 }),
});

type VerifyFieldMap = { verify: ReturnType<typeof verifyField> };
type SettleFieldMap = ReturnType<typeof settleFields>;
export type PostActionObservationFields<TName extends string> =
  PostActionObservationSupportFor<TName> extends 'settle-and-verify'
    ? VerifyFieldMap & SettleFieldMap
    : PostActionObservationSupportFor<TName> extends 'settle'
      ? SettleFieldMap
      : {};

export function postActionObservationFields<const TName extends string>(
  command: TName,
): PostActionObservationFields<TName> {
  return {
    ...(commandSupportsVerifyEvidence(command) ? { verify: verifyField() } : {}),
    ...(commandSupportsSettleObservation(command) ? settleFields() : {}),
  } as PostActionObservationFields<TName>;
}

export function postActionObservationCliFlags(command: string): readonly FlagKey[] {
  const flags: FlagKey[] = [];
  if (commandSupportsVerifyEvidence(command)) flags.push('verify');
  if (commandSupportsSettleObservation(command)) flags.push(...SETTLE_FLAGS);
  return flags;
}
