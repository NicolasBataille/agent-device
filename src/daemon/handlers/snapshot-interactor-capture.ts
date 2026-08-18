import type {
  RunnerContext,
  SnapshotOptions,
  SnapshotResult,
} from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Legacy snapshot consumers that have not moved to a device-runtime operation
 * still capture through the selected interactor. Keeping this seam snapshot-
 * specific avoids restoring the retired generic command dispatcher route.
 */
export async function captureSnapshotWithInteractor(params: {
  device: DeviceInfo;
  runnerContext: RunnerContext;
  options: SnapshotOptions;
}): Promise<SnapshotResult> {
  const { getInteractor } = await import('../../core/interactors.ts');
  const interactor = await getInteractor(params.device, params.runnerContext);
  return await interactor.snapshot(params.options);
}
