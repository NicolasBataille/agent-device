import { normalizePlatformSelector } from '../../utils/device.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { clearRuntimeHintsFromApp, hasRuntimeTransportHints } from '../runtime-hints.ts';
import { errorResponse } from './response.ts';
import {
  buildRuntimeHints,
  countConfiguredRuntimeHints,
  mergeRuntimeHints,
  toRuntimePlatform,
} from './session-runtime.ts';
import {
  configureProviderPortReverse,
  removeProviderPortReverse,
} from '../../provider-device-runtime.ts';

export async function handleRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const action = (req.positionals?.[0] ?? 'show').toLowerCase();
  const session = sessionStore.get(sessionName);
  const current = sessionStore.getRuntimeHints(sessionName);
  if (action === 'port-reverse' || action === 'port-reverse-remove') {
    return await handlePortReverseCommand(req, action);
  }
  if (!['set', 'show', 'clear'].includes(action)) {
    return errorResponse('INVALID_ARGS', 'runtime requires set, show, clear, or port-reverse');
  }
  if (action === 'clear') {
    if (hasRuntimeTransportHints(current) && session?.appBundleId) {
      await clearRuntimeHintsFromApp({
        device: session.device,
        appId: session.appBundleId,
      });
    }
    const cleared = sessionStore.clearRuntimeHints(sessionName);
    return { ok: true, data: { session: sessionName, cleared } };
  }
  if (action === 'show') {
    return {
      ok: true,
      data: {
        session: sessionName,
        configured: Boolean(current),
        runtime: current,
      },
    };
  }

  const platform = toRuntimePlatform(
    normalizePlatformSelector(req.flags?.platform) ?? current?.platform ?? session?.device.platform,
  );
  if (!platform) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set only supports iOS and Android sessions. Pass --platform ios|android or open an iOS/Android session first.',
    );
  }
  if (session && session.device.platform !== platform) {
    return errorResponse(
      'INVALID_ARGS',
      `runtime set targets ${platform}, but session "${sessionName}" is already bound to ${session.device.platform}.`,
    );
  }
  const nextRuntime = mergeRuntimeHints(current, buildRuntimeHints(req.flags, platform));
  if (countConfiguredRuntimeHints(nextRuntime) === 0) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set requires at least one hint such as --metro-host, --metro-port, --bundle-url, or --launch-url.',
    );
  }
  sessionStore.setRuntimeHints(sessionName, nextRuntime);
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: true,
      runtime: nextRuntime,
    },
  };
}

async function handlePortReverseCommand(
  req: DaemonRequest,
  action: 'port-reverse' | 'port-reverse-remove',
): Promise<DaemonResponse> {
  const leaseId = req.flags?.leaseId;
  const provider = req.flags?.leaseProvider;
  if (!leaseId) {
    return errorResponse('INVALID_ARGS', 'runtime port-reverse requires a resolved remote lease.');
  }
  const devicePort = readTcpPort(req.flags?.devicePort);
  const hostPort = readTcpPort(req.flags?.hostPort ?? req.flags?.devicePort);
  if (!devicePort || !hostPort) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime port-reverse requires numeric devicePort and hostPort values from 1 to 65535.',
    );
  }
  const name = req.flags?.portReverseName?.trim() || 'runtime';
  const options = { leaseId, provider, devicePort, hostPort, name };
  const result =
    action === 'port-reverse'
      ? await configureProviderPortReverse(options)
      : await removeProviderPortReverse(options);
  if (!result) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'No active provider device runtime supports port reverse for this lease.',
    );
  }
  return {
    ok: true,
    data: {
      action,
      ...result,
    },
  };
}

function readTcpPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return undefined;
  }
  return value;
}
