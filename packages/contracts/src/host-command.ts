/**
 * Host-command result vocabulary.
 *
 * The SHAPE of a finished host command, split from the code that runs one.
 * `src/utils/exec.ts` keeps the running — process spawning, argument policy,
 * timeouts, redaction — because that is host policy the root composition owns
 * (#1490 keeps `exec` root-side deliberately). What every caller passes around
 * afterwards is just this record, and that is vocabulary.
 *
 * The split is load-bearing rather than tidy: 13 of the ~22 modules that named
 * this type live under `src/platforms/`, and they wanted only the type. Leaving
 * it in `utils/exec.ts` meant every platform module imported root code to
 * describe a value it already had — a dependency that no platform package could
 * ever satisfy, for a type with no runtime behavior at all.
 */
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Present only when the command was run with `binaryStdout`. */
  stdoutBuffer?: Buffer;
};
