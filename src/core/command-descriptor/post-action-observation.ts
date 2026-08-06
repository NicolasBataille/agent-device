export type PostActionObservationSupport = 'settle' | 'settle-and-verify';

/**
 * The single source for which commands accept `--settle`/`--verify` (#1101,
 * #1047). Every downstream seam — CLI flag grammar, MCP/SDK input fields,
 * daemon flag guards, timeout policy, dispatch wiring — derives its answer
 * from this map rather than repeating a command list.
 *
 * `scroll` and `back` (#1638) carry `settle` only: they resolve no target, so
 * there is no pre-action node to digest into `--verify` evidence. Their
 * settled diff is taken against the STORED pre-action snapshot, which the
 * generic route holds instead of a freshly resolved baseline.
 */
const POST_ACTION_OBSERVATION_BY_COMMAND = {
  click: 'settle-and-verify',
  press: 'settle-and-verify',
  fill: 'settle-and-verify',
  longpress: 'settle',
  scroll: 'settle',
  back: 'settle',
} as const satisfies Record<string, PostActionObservationSupport>;

export type PostActionObservationCommandName = keyof typeof POST_ACTION_OBSERVATION_BY_COMMAND;

export type PostActionObservationSupportFor<TName extends string> =
  TName extends PostActionObservationCommandName
    ? (typeof POST_ACTION_OBSERVATION_BY_COMMAND)[TName]
    : undefined;

export function resolvePostActionObservationSupport(
  command: string | undefined,
): PostActionObservationSupport | undefined {
  if (command === undefined) return undefined;
  return POST_ACTION_OBSERVATION_BY_COMMAND[command as PostActionObservationCommandName];
}
