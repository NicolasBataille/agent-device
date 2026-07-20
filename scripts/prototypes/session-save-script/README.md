# Session save-script API lab

This is a deliberately throwaway, in-memory prototype. It does not call agent-device, write `.ad`
files, or model every replay edge case.

## Question

Does this authoring flow feel coherent for one reusable journey: start by opening the app, perform
everything needed to reach screen X, then save without closing the app?

```sh
agent-device open com.example.app --save-script=screen-x.ad
# perform actions
agent-device wait 'label="Screen X"'
agent-device session save-script
# session remains active
agent-device close

# later, from no active session
agent-device replay screen-x.ad
```

`--save-script=<path>` must be present on `open`: full target identity evidence is captured while each
interaction happens and cannot be reconstructed by an end-only save. `session save-script` publishes
`open` plus all recorded actions, never adds `close`, and disarms close-time publication. Replaying the
artifact therefore starts from scratch and leaves the session active at the destination. Publication
requires a final target-bearing `wait`; an existing path is refused unless `--force` is present.

## Run

```sh
pnpm prototype:session-save-script
```

Try this sequence:

```text
open com.example.app --save-script=notification-preferences.ad
navigate
session save-script
close
replay notification-preferences.ad
```

If the command and defaults survive this lab, the production design still needs an ADR and must
reuse the existing session history, atomic writer, no-clobber behavior, and replay parser.

Intermediate fragments, arbitrary start/stop ranges, parameterized secret inputs (#1348), `include`,
and composed-flow healing are intentionally out of scope.
