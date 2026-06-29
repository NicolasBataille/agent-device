import type { InstanceClient as LimrunAndroidClient } from '@limrun/api/instance-client';
import type { InstanceClient as LimrunIosClient } from '@limrun/api/ios-client';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { AndroidPortReverseProvider } from '../platforms/android/adb-executor.ts';
import type { DeviceInfo } from '../utils/device.ts';

export type LimrunAdbTunnel = Awaited<ReturnType<LimrunAndroidClient['startAdbTunnel']>>;

export type LimrunInstance = {
  metadata: { id: string };
  status: {
    token: string;
    apiUrl?: string;
    adbWebSocketUrl?: string;
    state?: string;
  };
};

export type LimrunIosSession = {
  platform: 'ios';
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  client: LimrunIosClient;
};

export type LimrunAndroidSession = {
  platform: 'android';
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  client: LimrunAndroidClient;
  adbTunnel?: LimrunAdbTunnel;
  adbSerial?: string;
  portReverse?: AndroidPortReverseProvider;
};

export type LimrunRuntimeSession = LimrunIosSession | LimrunAndroidSession;

export type LimrunRuntimeOptions = {
  apiKey: string;
  region?: string;
  version?: string;
};

export const LIMRUN_CLIENT_HEADER = 'agent-device-cli';
export const SETTINGS_INTENT = 'android.settings.SETTINGS';
