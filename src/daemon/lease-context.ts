import type { DaemonRequest } from './types.ts';
import type { LeaseBackend } from '../contracts.ts';
import type { DeviceLease } from './lease-registry.ts';
import type { SessionState } from './types.ts';

export const PROXY_LEASE_PROVIDER = 'proxy';
export const DEFAULT_PROXY_LEASE_TTL_MS = 300_000;
export const REQUIRED_PROXY_LEASE_FIELDS = [
  'leaseId',
  'tenantId',
  'runId',
  'clientId',
  'deviceKey',
] as const satisfies readonly (keyof LeaseScope)[];

export type LeaseScope = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseBackend?: LeaseBackend;
  clientId?: string;
  leaseProvider?: string;
  deviceKey?: string;
  expiresAt?: number;
};

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return {
    tenantId: req.meta?.tenantId ?? req.flags?.tenant,
    runId: req.meta?.runId ?? req.flags?.runId,
    leaseId: req.meta?.leaseId ?? req.flags?.leaseId,
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseBackend: req.meta?.leaseBackend,
    clientId: req.meta?.clientId,
    leaseProvider: req.meta?.leaseProvider,
    deviceKey: req.meta?.deviceKey,
  };
}

export function resolveRequestOrSessionLeaseScope(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  session: SessionState | undefined,
): LeaseScope {
  const requestLease = resolveLeaseScope(req);
  const sessionLease = session?.lease;
  if (requestLease.leaseId) {
    return {
      tenantId: requestLease.tenantId ?? sessionLease?.tenantId,
      runId: requestLease.runId ?? sessionLease?.runId,
      leaseId: requestLease.leaseId,
      leaseTtlMs: requestLease.leaseTtlMs,
      leaseBackend:
        requestLease.leaseBackend ?? normalizeSessionLeaseBackend(sessionLease?.backend),
      clientId: requestLease.clientId ?? sessionLease?.clientId,
      leaseProvider: requestLease.leaseProvider ?? sessionLease?.leaseProvider,
      deviceKey: requestLease.deviceKey ?? sessionLease?.deviceKey,
      expiresAt: sessionLease?.expiresAt,
    };
  }
  if (!sessionLease) return requestLease;
  return {
    tenantId: sessionLease.tenantId,
    runId: sessionLease.runId,
    leaseId: sessionLease.leaseId,
    leaseTtlMs: requestLease.leaseTtlMs,
    leaseBackend: normalizeSessionLeaseBackend(sessionLease.backend),
    clientId: sessionLease.clientId,
    leaseProvider: sessionLease.leaseProvider,
    deviceKey: sessionLease.deviceKey,
    expiresAt: sessionLease.expiresAt,
  };
}

export function buildSessionLeaseFromRequest(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  activeLease?: DeviceLease,
): SessionState['lease'] | undefined {
  const scope = resolveLeaseScope(req);
  if (!scope.leaseId && !activeLease?.leaseId) return undefined;
  const leaseId = scope.leaseId ?? activeLease?.leaseId;
  const tenantId = scope.tenantId ?? activeLease?.tenantId;
  const runId = scope.runId ?? activeLease?.runId;
  if (!leaseId || !tenantId || !runId) return undefined;
  return {
    leaseId,
    tenantId,
    runId,
    clientId: scope.clientId,
    backend: scope.leaseBackend ?? activeLease?.backend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    expiresAt: activeLease?.expiresAt,
  };
}

export function isProxyLeaseScope(scope: LeaseScope): boolean {
  return scope.leaseProvider === PROXY_LEASE_PROVIDER;
}

export function findMissingProxyLeaseFields(scope: LeaseScope): string[] {
  if (!isProxyLeaseScope(scope)) return [];
  return REQUIRED_PROXY_LEASE_FIELDS.filter((field) => !scope[field]);
}

function normalizeSessionLeaseBackend(raw: string | undefined): LeaseBackend | undefined {
  if (raw === 'ios-simulator' || raw === 'ios-instance' || raw === 'android-instance') {
    return raw;
  }
  return undefined;
}
