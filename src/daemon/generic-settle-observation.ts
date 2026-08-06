import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation, SettleParams } from '@agent-device/contracts/interaction';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { PostActionObservationCommandName } from '../core/command-descriptor/post-action-observation.ts';
import type { ContextFromFlags } from './handlers/interaction-common.ts';
import { readSettleRequest, settleFlagGuardResponse } from './handlers/interaction-flags.ts';
import { createInteractionRuntime } from './handlers/interaction-runtime.ts';
import { captureSnapshotForSession } from './handlers/interaction-snapshot.ts';
import { issueSettleObservationRefs } from './session-snapshot.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';

/**
 * `--settle` (#1101) for the generic daemon route (#1638) — today `scroll` and
 * `back`, the two generic leaves carrying the descriptor post-action
 * observation trait.
 *
 * It lives in its own module, loaded lazily by request-generic-dispatch.ts only
 * when a settle-capable command actually asks to settle, for the same reason
 * every daemon ROUTE is a lazy seam (src/daemon/request-handler-chain.ts):
 * observing pulls in the whole interaction runtime, and no other generic leaf —
 * home, screenshot, orientation, tv-remote — should pay for it in import cost
 * or in comprehension (the static edge would fold that runtime cluster into the
 * daemon's largest type cycle).
 */

type GenericSettleReadiness = { settle: SettleParams | undefined } | { response: DaemonResponse };

/**
 * Reads the settle request off the flags, refusing an orphaned
 * `--settle-quiet`. Called before the device action so a grammar mistake costs
 * no device work — and only for a command the caller already checked carries
 * the post-action observation trait, which is what makes the name cast sound.
 */
export function readGenericSettleRequest(
  command: string,
  flags: CommandFlags | undefined,
): GenericSettleReadiness {
  const invalid = settleFlagGuardResponse(command as PostActionObservationCommandName, flags);
  if (invalid) return { response: invalid };
  return { settle: readSettleRequest(flags) };
}

/**
 * Runs the target-less settle through the interaction runtime and attaches the
 * observation to the command's response payload.
 *
 * Best-effort by contract (the settle engine never throws): the device action
 * already succeeded, so a broken observation degrades to a hint rather than
 * failing the command.
 */
export async function observeGenericSettle(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
  settle: SettleParams;
  /** The session's STORED pre-action tree, read before the action dispatched. */
  baselineNodes: SnapshotNode[];
}): Promise<{ settle: SettleObservation }> {
  const { req, session, sessionName, settle, baselineNodes } = params;
  const runtime = createInteractionRuntime({
    req,
    sessionName,
    logPath: params.logPath,
    sessionStore: params.sessionStore,
    contextFromFlags: params.contextFromFlags,
    captureSnapshotForSession,
  });
  const observation = await runtime.interactions.observeSettle({
    ...settle,
    session: sessionName,
    requestId: req.meta?.requestId,
    baselineNodes,
  });
  // ADR 0014: a settled diff publishes refs minted from the stored settled
  // tree, so the response activates a partial frame and carries the generation
  // those refs are pinned to — the same dance the touch route runs.
  const refsGeneration = issueSettleObservationRefs(session, observation);
  return {
    settle: refsGeneration === undefined ? observation : { ...observation, refsGeneration },
  };
}
