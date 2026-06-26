import type { DaemonRequest } from './types.ts';
import type { LeaseBackend } from '../contracts.ts';

export type LeaseScope = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type SessionLease = {
  tenantId: string;
  runId: string;
  leaseId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type LeaseDiagnosticsContext = Omit<LeaseScope, 'leaseTtlMs'>;

type SessionLeaseSource = {
  lease?: SessionLease | null;
  deviceLease?: SessionLease | null;
};

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return {
    tenantId: req.meta?.tenantId ?? req.flags?.tenant,
    runId: req.meta?.runId ?? req.flags?.runId,
    leaseId: req.meta?.leaseId ?? req.flags?.leaseId,
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseBackend: req.meta?.leaseBackend,
    leaseProvider:
      req.meta?.leaseProvider ??
      readFlagString(req.flags, 'leaseProvider') ??
      readFlagString(req.flags, 'provider'),
    deviceKey: req.meta?.deviceKey ?? readFlagString(req.flags, 'deviceKey'),
    clientId: req.meta?.clientId ?? readFlagString(req.flags, 'clientId'),
  };
}

export function buildSessionLeaseFromRequest(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
): SessionLease | undefined {
  const leaseScope = resolveLeaseScope(req);
  if (!leaseScope.tenantId || !leaseScope.runId || !leaseScope.leaseId) {
    return undefined;
  }
  return stripUndefined({
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    leaseId: leaseScope.leaseId,
    leaseBackend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
  });
}

export function resolveRequestOrSessionLeaseScope(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  session?: SessionLeaseSource | null,
): LeaseScope {
  const requestScope = resolveLeaseScope(req);
  const sessionLease = session?.lease ?? session?.deviceLease ?? undefined;
  return stripUndefined({
    tenantId: requestScope.tenantId ?? sessionLease?.tenantId,
    runId: requestScope.runId ?? sessionLease?.runId,
    leaseId: requestScope.leaseId ?? sessionLease?.leaseId,
    leaseTtlMs: requestScope.leaseTtlMs,
    leaseBackend: requestScope.leaseBackend ?? sessionLease?.leaseBackend,
    leaseProvider: requestScope.leaseProvider ?? sessionLease?.leaseProvider,
    deviceKey: requestScope.deviceKey ?? sessionLease?.deviceKey,
    clientId: requestScope.clientId ?? sessionLease?.clientId,
  });
}

export function buildLeaseDiagnosticsContext(
  leaseScope: LeaseScope | SessionLease | undefined,
): LeaseDiagnosticsContext | undefined {
  if (!leaseScope) return undefined;
  const context = stripUndefined({
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    leaseId: leaseScope.leaseId,
    leaseBackend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

function readFlagString(flags: object | undefined, key: string): string | undefined {
  const value = (flags as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
