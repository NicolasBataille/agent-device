import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from './device-inventory.ts';

export type EnsureReadyInput = Readonly<{
  serial?: string;
  androidSerialAllowlist?: readonly string[];
}>;

export type DeviceReadinessRuntimeOperations = Readonly<{
  ensureReady(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTarget(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTargetHeadless(input: EnsureReadyInput): Promise<DeviceInfo>;
}>;

export type DeviceReadinessRuntimeHost = Readonly<{
  applePhysical: Readonly<{
    ensureConnected(device: DeviceInfo, signal: AbortSignal): Promise<void>;
  }>;
  appleAutomation: Readonly<{
    keepHot(device: DeviceInfo): void;
  }>;
  androidEmulator: Readonly<{
    discover(request: DeviceInventoryRequest, signal: AbortSignal): Promise<readonly DeviceInfo[]>;
    launch(avdName: string, headless: boolean): number;
    terminate(pid: number): Promise<void>;
  }>;
}>;
