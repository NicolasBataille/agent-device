import Limrun from '@limrun/api';
import { createInstanceClient as createAndroidInstanceClient } from '@limrun/api/instance-client';
import { createInstanceClient as createIosInstanceClient } from '@limrun/api/ios-client';
import { AppError } from '../utils/errors.ts';
import { readVersion } from '../utils/version.ts';
import type { DeviceInfo } from '../utils/device.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { DeviceInventoryProvider } from '../core/dispatch-resolve.ts';
import type { LeaseLifecycleProvider } from '../daemon/handlers/lease.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderPortReverseOptions,
} from '../provider-device-runtime.ts';
import {
  buildLimrunDevice,
  LIMRUN_PROVIDER,
  parseLimrunDeviceId,
  platformForLimrunLeaseBackend,
  readLimrunLeaseIdFromInventoryRequest,
} from './limrun-device.ts';
import {
  cleanupAndroidAdbTunnel,
  ensureAndroidPortReverse,
  removeAndroidPortReverse,
} from './limrun-android-adb.ts';
import { LimrunAndroidInteractor } from './limrun-android-interactor.ts';
import { installLimrunAndroidApp, installLimrunIosApp } from './limrun-install.ts';
import { LimrunIosInteractor } from './limrun-ios-interactor.ts';
import {
  LIMRUN_CLIENT_HEADER,
  type LimrunInstance,
  type LimrunRuntimeOptions,
  type LimrunRuntimeSession,
} from './limrun-session.ts';
import { unsupported } from './limrun-utils.ts';

export { readLocalhostUrlPort } from './limrun-utils.ts';

export function createLimrunRuntimeFromEnv(env: NodeJS.ProcessEnv): LimrunRuntime | undefined {
  const apiKey = env.LIMRUN_API_KEY?.trim() || env.LIM_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new LimrunRuntime({
    apiKey,
    region: env.LIMRUN_REGION?.trim() || env.LIM_REGION?.trim() || undefined,
    version: readVersion(),
  });
}

export class LimrunRuntime implements ProviderDeviceRuntime {
  private readonly limrun: Limrun;
  private readonly sessions = new Map<string, LimrunRuntimeSession>();
  private readonly options: LimrunRuntimeOptions;
  readonly provider = LIMRUN_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => await this.allocate(lease),
    release: async (lease) => await this.release(lease.leaseId),
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = readLimrunLeaseIdFromInventoryRequest(request);
    if (!leaseId) return null;
    const session = this.sessions.get(leaseId);
    if (!session) return null;
    if (request.platform && request.platform !== session.platform) return [];
    return [session.device];
  };

  constructor(options: LimrunRuntimeOptions) {
    this.options = options;
    this.limrun = new Limrun({
      apiKey: options.apiKey,
      defaultHeaders: {
        'x-agent-device-client': LIMRUN_CLIENT_HEADER,
        'x-agent-device-version': options.version ?? readVersion(),
      },
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseLimrunDeviceId(device.id) !== undefined;
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    if (!session || session.platform !== parsed.platform) return undefined;
    return session.platform === 'ios'
      ? new LimrunIosInteractor(session)
      : new LimrunAndroidInteractor(session);
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(device, appPath, {
      ...options,
      appIdentifierHint: options?.appIdentifierHint ?? app,
      packageNameHint: options?.packageNameHint ?? app,
    });
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? await installLimrunIosApp(this.limrun, session, installablePath, options)
      : await installLimrunAndroidApp(this.limrun, session, installablePath, options);
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(options.leaseId);
    if (!session) return undefined;
    if (session.platform !== 'android') {
      throw unsupported(
        'port reverse',
        'Direct Limrun iOS sessions cannot reach local host ports; use a bridge public URL.',
      );
    }
    await ensureAndroidPortReverse(session, options);
    return portReverseResult(options);
  }

  async removePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(options.leaseId);
    if (!session) return undefined;
    if (session.platform !== 'android') return undefined;
    await removeAndroidPortReverse(session, options.devicePort);
    return portReverseResult(options);
  }

  async shutdown(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    await Promise.allSettled(sessions.map((session) => this.terminateSession(session)));
    this.sessions.clear();
  }

  private async allocate(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const existing = this.sessions.get(lease.leaseId);
    if (existing) {
      return { limrunInstanceId: existing.instanceId, device: existing.device };
    }

    const session =
      platform === 'ios'
        ? await this.createIosSession(lease)
        : await this.createAndroidSession(lease);
    this.sessions.set(lease.leaseId, session);
    return { limrunInstanceId: session.instanceId, device: session.device };
  }

  private async createIosSession(lease: DeviceLease): Promise<LimrunRuntimeSession> {
    const instance = (await this.limrun.iosInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl) {
        throw new AppError('COMMAND_FAILED', 'Limrun iOS instance did not expose apiUrl');
      }
      const client = await createIosInstanceClient({
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
        logLevel: 'warn',
      });
      return {
        platform: 'ios',
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('ios', lease, instance.metadata.id),
        client,
      };
    } catch (error) {
      await this.limrun.iosInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
  }

  private async createAndroidSession(lease: DeviceLease): Promise<LimrunRuntimeSession> {
    const instance = (await this.limrun.androidInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) {
        throw new AppError(
          'COMMAND_FAILED',
          'Limrun Android instance did not expose API and ADB websocket endpoints',
        );
      }
      const client = await createAndroidInstanceClient({
        apiUrl: instance.status.apiUrl,
        adbUrl: instance.status.adbWebSocketUrl,
        token: instance.status.token,
        logLevel: 'warn',
      });
      return {
        platform: 'android',
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('android', lease, instance.metadata.id),
        client,
      };
    } catch (error) {
      await this.limrun.androidInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
  }

  private buildInstanceMetadata(lease: DeviceLease) {
    return {
      displayName: `agent-device-${lease.tenantId}-${lease.runId}`,
      labels: {
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseId: lease.leaseId,
        provider: lease.leaseProvider ?? LIMRUN_PROVIDER,
        source: LIMRUN_CLIENT_HEADER,
      },
    };
  }

  private async release(leaseId: string): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(leaseId);
    if (!session) return undefined;
    await this.terminateSession(session);
    this.sessions.delete(leaseId);
    return { limrunInstanceId: session.instanceId };
  }

  private async terminateSession(session: LimrunRuntimeSession): Promise<void> {
    session.client.disconnect();
    if (session.platform === 'ios') {
      await this.limrun.iosInstances.delete(session.instanceId);
      return;
    }
    await cleanupAndroidAdbTunnel(session);
    await this.limrun.androidInstances.delete(session.instanceId);
  }

  private getSessionForDevice(device: DeviceInfo): LimrunRuntimeSession | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    if (!session || session.platform !== parsed.platform) return undefined;
    return session;
  }
}

function portReverseResult(options: ProviderPortReverseOptions): Record<string, unknown> {
  return {
    leaseId: options.leaseId,
    devicePort: options.devicePort,
    hostPort: options.hostPort,
    name: options.name,
  };
}
