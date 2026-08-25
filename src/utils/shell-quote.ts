// Re-exported from the kernel so the string-quoting helpers have a single home
// shared with the branded `ShellSafe` device-shell atoms (`@agent-device/kernel/shell`).
// Callers that build human-facing hint strings keep using these plain-string
// helpers; device-shell argv must go through `sh.*` / the typed funnels instead.
export { shellQuote, shellQuoteIfNeeded } from '@agent-device/kernel/shell';
