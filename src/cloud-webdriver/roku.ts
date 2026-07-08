import type { CloudArtifactProvider } from '../cloud-artifacts.ts';
import type { DeviceInventoryProvider, DeviceInventoryRequest } from '../core/dispatch-resolve.ts';
import type { Interactor, ScreenshotOptions, SnapshotOptions } from '../core/interactor-types.ts';
import type { BackMode } from '../core/back-mode.ts';
import type { DeviceRotation } from '../core/device-rotation.ts';
import type { TransformGestureParams } from '../core/scroll-gesture.ts';
import type { TvRemoteButton } from '../core/tv-remote.ts';
import type { LeaseLifecycleProvider } from '../daemon/handlers/lease.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { DaemonRequest } from '../daemon/types.ts';
import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
import type { DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import type { SettingOptions } from '../platforms/permission-utils.ts';
import { sleep } from '../utils/timeouts.ts';
import { unavailableCloudArtifactsResult } from './artifact-results.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { parseWebDriverSource } from './webdriver-source.ts';
import { trimLeadingSlash, withTrailingSlash } from './webdriver-utils.ts';

export const ROKU_CAPABILITIES = {
  provider: CLOUD_WEBDRIVER_PROVIDERS.roku,
  platform: 'web',
  target: 'tv',
  snapshotSource: 'roku-webdriver-source',
  operations: {
    lease: { support: 'supported' },
    inventory: {
      support: 'partial',
      note: 'Inventory exposes only the leased Roku device.',
    },
    open: { support: 'supported' },
    close: {
      support: 'partial',
      note: 'Uses Roku ECP exit-app when the device permits it.',
    },
    snapshot: {
      support: 'partial',
      note: 'Decodes Roku WebDriver base64 page source XML.',
    },
    tvRemote: {
      support: 'supported',
      note: 'Uses Roku ECP keypress/keydown/keyup remote input.',
    },
    screenshot: {
      support: 'unsupported',
      note: 'Roku WebDriver does not document a screenshot endpoint.',
    },
    install: {
      support: 'unsupported',
      note: 'Roku store install and sideload flows need dedicated package handling.',
    },
  },
} as const;

export type RokuWebDriverRuntimeOptions = {
  endpoint?: string | URL;
  ecpEndpoint?: string | URL;
  deviceIp?: string;
  deviceName?: string;
  channelId?: string;
  requestPolicy?: RokuWebDriverRequestPolicy;
};

type RokuWebDriverRequestPolicy = {
  timeoutMs?: number;
};

type RokuSession = {
  sessionId: string;
  endpoint: string | URL;
  deviceIp: string;
  deviceName: string;
  channelId?: string;
  client: RokuWebDriverClient;
  interactor: Interactor;
  device: DeviceInfo;
};

type RokuCreateSessionResult = {
  sessionId: string;
  deviceName?: string;
  raw: Record<string, unknown>;
};

export function createRokuWebDriverRuntime(
  options: RokuWebDriverRuntimeOptions = {},
): ProviderDeviceRuntime {
  return new RokuWebDriverRuntime(options);
}

class RokuWebDriverRuntime implements ProviderDeviceRuntime {
  readonly provider = CLOUD_WEBDRIVER_PROVIDERS.roku;
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;

  private readonly options: RokuWebDriverRuntimeOptions;
  private readonly sessionsByLeaseId = new Map<string, RokuSession>();

  constructor(options: RokuWebDriverRuntimeOptions) {
    this.options = options;
    this.leaseLifecycle = {
      allocate: async (lease, context) => await this.allocate(lease, context?.req),
      heartbeat: async (lease) => this.heartbeat(lease),
      release: async (lease) => await this.release(lease),
    };
    this.cloudArtifacts = {
      listCloudArtifacts: async (query) => {
        if (query.provider !== this.provider) return undefined;
        return unavailableCloudArtifactsResult({
          provider: this.provider,
          providerSessionId: query.providerSessionId ?? '',
          error: new AppError(
            'UNSUPPORTED_OPERATION',
            'Roku provider does not expose cloud artifacts.',
          ),
        });
      },
    };
    this.deviceInventoryProvider = async (request) => {
      if (request.leaseProvider !== this.provider) return null;
      if (!request.leaseId) {
        const settings = resolveRokuSettings(this.options, request);
        return [createRokuDevice(settings.deviceIp, settings.deviceName)];
      }
      const session = this.sessionsByLeaseId.get(request.leaseId);
      return session ? [session.device] : [];
    };
  }

  ownsDevice(device: DeviceInfo): boolean {
    return [...this.sessionsByLeaseId.values()].some((session) => session.device.id === device.id);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.sessionsByLeaseId.values()].map((session) => session.client.deleteSession()),
    );
    this.sessionsByLeaseId.clear();
  }

  private async allocate(
    lease: DeviceLease,
    req?: DaemonRequest,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    if (this.sessionsByLeaseId.has(lease.leaseId)) return this.heartbeat(lease);

    const settings = resolveRokuSettings(this.options, req);
    const client = new RokuWebDriverClient({
      endpoint: settings.endpoint,
      ecpEndpoint: settings.ecpEndpoint,
      deviceIp: settings.deviceIp,
      requestPolicy: this.options.requestPolicy,
    });
    const created = await client.createSession();
    const deviceName = settings.deviceName ?? created.deviceName;
    const device = createRokuDevice(settings.deviceIp, deviceName);
    const session: RokuSession = {
      sessionId: created.sessionId,
      endpoint: settings.endpoint,
      deviceIp: settings.deviceIp,
      deviceName: device.name,
      channelId: settings.channelId,
      client,
      device,
      interactor: new RokuInteractor(client, settings.channelId),
    };
    this.sessionsByLeaseId.set(lease.leaseId, session);
    return {
      provider: this.provider,
      sessionId: created.sessionId,
      providerSessionId: created.sessionId,
      deviceId: device.id,
      capabilities: ROKU_CAPABILITIES,
      roku: {
        endpoint: String(settings.endpoint),
        deviceIp: settings.deviceIp,
        channelId: settings.channelId,
        session: created.raw,
      },
    };
  }

  private heartbeat(lease: DeviceLease): Record<string, unknown> | undefined {
    if (lease.leaseProvider !== this.provider) return undefined;
    if (!this.sessionsByLeaseId.has(lease.leaseId)) return undefined;
    return { provider: this.provider };
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const session = this.sessionsByLeaseId.get(lease.leaseId);
    if (!session) return undefined;
    this.sessionsByLeaseId.delete(lease.leaseId);
    await session.client.deleteSession();
    return {
      provider: this.provider,
      providerSessionId: session.sessionId,
    };
  }
}

class RokuInteractor implements Interactor {
  private activeChannelId: string | undefined;
  private readonly client: RokuWebDriverClient;
  private readonly defaultChannelId: string | undefined;

  constructor(client: RokuWebDriverClient, defaultChannelId: string | undefined) {
    this.client = client;
    this.defaultChannelId = defaultChannelId;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      throw unsupportedRokuOperation('open URL');
    }
    const channelId = this.resolveChannelId(app);
    await this.client.launch(channelId);
    this.activeChannelId = channelId;
  }

  async openDevice(): Promise<void> {
    const channelId = this.resolveChannelId(undefined);
    await this.client.launch(channelId);
    this.activeChannelId = channelId;
  }

  async close(app: string): Promise<void> {
    const channelId = app || this.activeChannelId || this.defaultChannelId;
    if (!channelId) return;
    await this.client.exitApp(channelId);
  }

  async tap(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('tap');
  }

  async doubleTap(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('doubleTap');
  }

  async swipe(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('swipe');
  }

  async pan(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('pan');
  }

  async fling(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('fling');
  }

  async longPress(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('longPress');
  }

  async focus(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('focus');
  }

  async type(): Promise<void> {
    throw unsupportedRokuOperation('type');
  }

  async fill(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('fill');
  }

  async scroll(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('scroll');
  }

  async pinch(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('pinch');
  }

  async screenshot(_outPath: string, _options?: ScreenshotOptions): Promise<void> {
    throw unsupportedRokuOperation('screenshot');
  }

  async snapshot(_options?: SnapshotOptions) {
    return {
      backend: 'web' as const,
      nodes: parseWebDriverSource(await this.client.source()),
    };
  }

  async back(_mode?: BackMode): Promise<void> {
    await this.tvRemote('back');
  }

  async home(): Promise<void> {
    await this.tvRemote('home');
  }

  async rotate(_orientation: DeviceRotation): Promise<void> {
    throw unsupportedRokuOperation('rotate');
  }

  async rotateGesture(): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('rotateGesture');
  }

  async transformGesture(
    _options: TransformGestureParams,
  ): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('transformGesture');
  }

  async appSwitcher(): Promise<void> {
    throw unsupportedRokuOperation('appSwitcher');
  }

  async tvRemote(button: TvRemoteButton, durationMs?: number): Promise<void> {
    await this.client.pressRemote(button, durationMs);
  }

  async readClipboard(): Promise<string> {
    throw unsupportedRokuOperation('clipboard.read');
  }

  async writeClipboard(_text: string): Promise<void> {
    throw unsupportedRokuOperation('clipboard.write');
  }

  async setSetting(
    _setting: string,
    _state: string,
    _appId?: string,
    _options?: SettingOptions,
  ): Promise<Record<string, unknown> | void> {
    throw unsupportedRokuOperation('settings');
  }

  private resolveChannelId(app: string | undefined): string {
    const channelId = app || this.defaultChannelId;
    if (channelId) return channelId;
    throw new AppError(
      'INVALID_ARGS',
      'Roku open requires a channel id. Pass open <channel-id> or configure --provider-app.',
    );
  }
}

class RokuWebDriverClient {
  private readonly endpoint: URL;
  private readonly options: {
    endpoint: string | URL;
    ecpEndpoint?: string | URL;
    deviceIp: string;
    requestPolicy?: RokuWebDriverRequestPolicy;
  };
  private readonly timeoutMs: number;
  private sessionId: string | undefined;

  constructor(options: {
    endpoint: string | URL;
    ecpEndpoint?: string | URL;
    deviceIp: string;
    requestPolicy?: RokuWebDriverRequestPolicy;
  }) {
    this.options = options;
    this.endpoint = withTrailingSlash(new URL(options.endpoint));
    this.timeoutMs = options.requestPolicy?.timeoutMs ?? 30_000;
  }

  async createSession(): Promise<RokuCreateSessionResult> {
    const value = await this.webDriverRequest('POST', '/v1/session', {
      ip: this.options.deviceIp,
    });
    const session = readRokuSession(value);
    this.sessionId = session.sessionId;
    return session;
  }

  async deleteSession(): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.webDriverRequest('DELETE', `/v1/session/${sessionId}`);
    this.sessionId = undefined;
  }

  async launch(channelId: string): Promise<void> {
    await this.sessionRequest('POST', '/launch', { channelId });
  }

  async source(): Promise<string> {
    const value = await this.sessionRequest('GET', '/source');
    const encoded = typeof value === 'string' ? value : undefined;
    if (!encoded) {
      throw new AppError('COMMAND_FAILED', 'Roku WebDriver source response missed base64 value.', {
        valueType: typeof value,
      });
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  async pressRemote(button: TvRemoteButton, durationMs: number | undefined): Promise<void> {
    const key = rokuKeyForButton(button);
    if (durationMs && durationMs > 0) {
      await this.ecpRequest('POST', `/keydown/${key}`);
      await sleep(durationMs);
      await this.ecpRequest('POST', `/keyup/${key}`);
      return;
    }
    await this.ecpRequest('POST', `/keypress/${key}`);
  }

  async exitApp(channelId: string): Promise<void> {
    await this.ecpRequest('POST', `/exit-app/${encodeURIComponent(channelId)}/true`);
  }

  private async sessionRequest(
    method: string,
    pathSuffix: string,
    body?: unknown,
  ): Promise<unknown> {
    return await this.webDriverRequest(
      method,
      `/v1/session/${this.requireSessionId()}${pathSuffix}`,
      body,
    );
  }

  private async webDriverRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(trimLeadingSlash(path), this.endpoint), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...agentDeviceRequestHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const payload = text ? parseJsonResponse(text) : {};
    if (!response.ok) throw rokuRequestError('Roku WebDriver request failed', response, payload);
    return readRokuValue(payload);
  }

  private async ecpRequest(method: string, path: string): Promise<void> {
    const response = await fetch(new URL(trimLeadingSlash(path), this.ecpBaseUrl()), {
      method,
      headers: agentDeviceRequestHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new AppError(
        'COMMAND_FAILED',
        `Roku ECP request failed with HTTP ${response.status}.`,
        {
          status: response.status,
          body: text,
        },
      );
    }
  }

  private ecpBaseUrl(): URL {
    if (this.options.ecpEndpoint) return withTrailingSlash(new URL(this.options.ecpEndpoint));
    return new URL(`http://${this.options.deviceIp}:8060/`);
  }

  private requireSessionId(): string {
    if (this.sessionId) return this.sessionId;
    throw new AppError('SESSION_NOT_FOUND', 'Roku WebDriver session has not been created yet.');
  }
}

function resolveRokuSettings(
  options: RokuWebDriverRuntimeOptions,
  req: DaemonRequest | DeviceInventoryRequest | undefined,
): {
  endpoint: string | URL;
  ecpEndpoint?: string | URL;
  deviceIp: string;
  deviceName?: string;
  channelId?: string;
} {
  const endpoint = readFlag(req, 'rokuWebDriverUrl') ?? options.endpoint;
  const deviceIp = readFlag(req, 'rokuDeviceIp') ?? options.deviceIp;
  if (!endpoint) {
    throw new AppError(
      'INVALID_ARGS',
      'Roku provider requires --roku-webdriver-url or ROKU_WEBDRIVER_URL.',
    );
  }
  if (!deviceIp) {
    throw new AppError(
      'INVALID_ARGS',
      'Roku provider requires --roku-device-ip or ROKU_DEVICE_IP.',
    );
  }
  return {
    endpoint,
    ecpEndpoint: options.ecpEndpoint,
    deviceIp,
    deviceName: readFlag(req, 'device') ?? readFlag(req, 'deviceName') ?? options.deviceName,
    channelId: readFlag(req, 'providerApp') ?? options.channelId,
  };
}

function readFlag(
  req: DaemonRequest | DeviceInventoryRequest | undefined,
  key: string,
): string | undefined {
  const source = req && 'flags' in req ? req.flags : req;
  const record = source as Record<string, unknown> | undefined;
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function createRokuDevice(deviceIp: string, deviceName: string | undefined): DeviceInfo {
  return {
    platform: 'web',
    target: 'tv',
    kind: 'device',
    id: `roku:${deviceIp}`,
    name: deviceName ?? `Roku ${deviceIp}`,
    booted: true,
  };
}

function readRokuSession(value: unknown): RokuCreateSessionResult {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', 'Roku WebDriver session response was not an object.', {
      response: value,
    });
  }
  const record = value as Record<string, unknown>;
  const sessionId =
    readString(record.sessionId) ??
    readString(record.session_id) ??
    readString(record.adId) ??
    readString(record.deviceAdId);
  if (!sessionId) {
    throw new AppError('COMMAND_FAILED', 'Roku WebDriver session response missed sessionId.', {
      response: value,
    });
  }
  const model = readString(record.model);
  const vendor = readString(record.vendor);
  const deviceName = [vendor, model].filter(Boolean).join(' ') || undefined;
  return { sessionId, deviceName, raw: record };
}

function readRokuValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  return 'value' in record ? record.value : payload;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Roku response was not valid JSON.', { text }, error);
  }
}

function rokuRequestError(message: string, response: Response, payload: unknown): AppError {
  return new AppError('COMMAND_FAILED', `${message} with HTTP ${response.status}.`, {
    status: response.status,
    response: payload,
  });
}

function unsupportedRokuOperation(operation: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `Roku WebDriver runtime does not support ${operation}.`,
    { provider: CLOUD_WEBDRIVER_PROVIDERS.roku, operation },
  );
}

function rokuKeyForButton(button: TvRemoteButton): string {
  switch (button) {
    case 'up':
      return 'Up';
    case 'down':
      return 'Down';
    case 'left':
      return 'Left';
    case 'right':
      return 'Right';
    case 'select':
      return 'Select';
    case 'menu':
      return 'Info';
    case 'home':
      return 'Home';
    case 'back':
      return 'Back';
  }
}
