import type { DeviceInfo } from '@agent-device/kernel/device';

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
  apple: Readonly<{
    ensureReady(
      device: DeviceInfo,
      options: Readonly<{ onColdBootStart?: () => void }>,
      signal: AbortSignal,
    ): Promise<void>;
    keepAutomationReady(device: DeviceInfo): void;
  }>;
  android: Readonly<{
    ensureReady(
      device: DeviceInfo,
      input: EnsureReadyInput & Readonly<{ headless: boolean }>,
      signal: AbortSignal,
    ): Promise<DeviceInfo>;
  }>;
}>;
