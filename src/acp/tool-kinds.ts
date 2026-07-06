import { getDaemonCommandRoute, getSessionCommandKind } from '../daemon/daemon-command-registry.ts';
import type { AcpToolKind } from './contracts.ts';

/**
 * Presentation-only mapping from agent-device commands to ACP tool kinds so
 * clients pick sensible icons. Derived from the daemon route/session-kind
 * traits where they say enough; the override map covers commands whose route
 * (`generic`, `session`+`state`, …) does not distinguish reads from actions.
 */
const TOOL_KIND_OVERRIDES: Readonly<Record<string, AcpToolKind>> = {
  get: 'read',
  is: 'read',
  wait: 'read',
  find: 'search',
  screenshot: 'read',
  diff: 'read',
  perf: 'read',
  audio: 'read',
  viewport: 'read',
  doctor: 'read',
  artifacts: 'read',
  network: 'read',
  install: 'execute',
  'install-from-source': 'execute',
  reinstall: 'execute',
  push: 'execute',
  boot: 'execute',
  shutdown: 'execute',
  open: 'execute',
  close: 'execute',
  prepare: 'execute',
  replay: 'execute',
  test: 'execute',
  batch: 'execute',
  record: 'execute',
  trace: 'execute',
  settings: 'execute',
  'trigger-app-event': 'execute',
  debug: 'read',
  metro: 'execute',
  session: 'read',
};

export function toolKindForCommand(command: string): AcpToolKind {
  const override = TOOL_KIND_OVERRIDES[command];
  if (override) return override;
  const route = getDaemonCommandRoute(command);
  if (route === 'snapshot' || route === 'find') return 'read';
  if (route === 'interaction') return 'execute';
  if (route === 'recordTrace' || route === 'reactNative') return 'execute';
  const sessionKind = getSessionCommandKind(command);
  if (sessionKind === 'inventory' || sessionKind === 'observability') return 'read';
  if (sessionKind === 'state' || sessionKind === 'replay') return 'execute';
  return 'other';
}
