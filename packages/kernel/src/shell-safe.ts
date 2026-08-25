// Device-shell command construction. `adb shell`, `adb exec-out <cmd>`, and
// `hdc shell` join their argv AFTER the subcommand into one string that the
// *device's* `sh` evaluates, so any unquoted dynamic element is an argv/command
// injection. The host itself never runs a shell (spawns are `shell: false`), so
// this is purely about what the device re-parses.
//
// The guarantee is type-level: the device-shell funnels accept `ShellSafe[]`,
// and a `ShellSafe` is produced only through the constructors here — so a raw
// `string` cannot reach a device shell. Bytes are preserved for legitimate
// input: `lit`/`arg` are the identity on the safe charset (see the parity
// test), so a value like `com.example.app` or a command word like `input` is
// byte-identical to the pre-migration argv; only a value that WOULD have been
// an injection vector changes (it gets quoted).

// Unquoted-safe shell token: no whitespace and no shell metacharacter, so the
// device `sh` treats it as a single literal word.
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote wrap (`'` → `'\''`), always safe as one argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote only when the value is not already an unquoted-safe token. */
export function shellQuoteIfNeeded(value: string): string {
  return SAFE_SHELL_TOKEN.test(value) ? value : shellQuote(value);
}

declare const shellSafeBrand: unique symbol;

/**
 * A string safe to place into a device shell command line. Opaque: the only
 * way to obtain one is through `sh.lit` / `sh.arg` / `sh.num` / `sh.raw`, which
 * is what lets the funnels type their argv as `ShellSafe[]` and reject raw
 * strings at compile time.
 */
export type ShellSafe = string & { readonly [shellSafeBrand]: 'shell-safe' };

/**
 * Device-shell argument constructors. Kept as a namespace so the escape hatch
 * (`sh.raw`) is greppable and can be held to an approved set by a static gate.
 */
export const sh = {
  /**
   * A compile-time-known command word or flag (`input`, `am`, `-n`). Validated:
   * a "literal" carrying a shell metacharacter is a bug — use `sh.arg` for a
   * value or `sh.raw` for a deliberately-authored fragment.
   */
  lit(token: string): ShellSafe {
    if (!SAFE_SHELL_TOKEN.test(token)) {
      throw new Error(
        `sh.lit: ${JSON.stringify(token)} is not a bare shell token; use sh.arg() for a value or sh.raw() for a fragment.`,
      );
    }
    return token as ShellSafe;
  },

  /** Convenience for a run of literal words: `...sh.lits('input', 'text')`. */
  lits(...tokens: readonly string[]): ShellSafe[] {
    return tokens.map((token) => sh.lit(token));
  },

  /**
   * Any dynamic value: shell-quoted so the device `sh` treats it as one literal
   * argument. A safe-charset value passes through unchanged (byte-identical to
   * a raw pre-migration argv); anything else is quoted.
   */
  arg(value: string): ShellSafe {
    return shellQuoteIfNeeded(value) as ShellSafe;
  },

  /** A numeric argument (coordinates, keycodes, timeouts). Always safe. */
  num(value: number): ShellSafe {
    return String(value) as ShellSafe;
  },

  /**
   * Escape hatch: a shell-script fragment the caller has authored and quoted
   * itself (loops, redirections, `${shellQuote(x)}` interpolation). The one
   * place a raw string becomes `ShellSafe` by assertion — greppable, and held
   * to an approved set by the `shell-safe` static gate. Every call MUST justify
   * why the fragment is safe.
   */
  raw(fragment: string): ShellSafe {
    return fragment as ShellSafe;
  },
} as const;

/** The argv passed to a device-shell funnel, after the `shell`/`exec-out` subcommand. */
export type ShellArgv = readonly ShellSafe[];

/** Render `ShellSafe[]` back to the plain `string[]` a spawn primitive takes. */
export function shellArgvToStrings(argv: ShellArgv): string[] {
  return argv as readonly string[] as string[];
}
