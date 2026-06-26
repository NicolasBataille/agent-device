import type { DaemonRequest } from './types.ts';
import type { RunnerLogicalLeaseContext } from '../core/runner-lease-context.ts';
import type { LeaseBackend } from '../contracts.ts';

export type LeaseScope = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseBackend?: LeaseBackend;
};

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return {
    tenantId: req.meta?.tenantId ?? req.flags?.tenant,
    runId: req.meta?.runId ?? req.flags?.runId,
    leaseId: req.meta?.leaseId ?? req.flags?.leaseId,
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseBackend: req.meta?.leaseBackend,
  };
}

export function resolveRunnerLogicalLeaseContext(
  req: Pick<DaemonRequest, 'meta'>,
): RunnerLogicalLeaseContext | undefined {
  const meta = req.meta as (DaemonRequest['meta'] & Record<string, unknown>) | undefined;
  const context = {
    leaseId: readNonEmptyString(meta?.leaseId),
    clientId: readNonEmptyString(meta?.clientId),
    tenantId: readNonEmptyString(meta?.tenantId),
    runId: readNonEmptyString(meta?.runId),
    leaseProvider:
      readNonEmptyString(meta?.leaseProvider) ?? readNonEmptyString(meta?.leaseBackend),
    deviceKey: readNonEmptyString(meta?.deviceKey),
  };
  return Object.values(context).some((value) => value !== undefined) ? context : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
