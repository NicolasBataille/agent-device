import {
  createAndroidPortReverseManager,
  type AndroidAdbExecutorOptions,
} from '../platforms/android/adb-executor.ts';
import { AppError } from '../utils/errors.ts';
import { runCmd } from '../utils/exec.ts';
import type { LimrunAndroidSession } from './limrun-session.ts';

export async function runLimrunAndroidAdb(
  session: LimrunAndroidSession,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<void> {
  const result = await runLimrunAndroidAdbCommand(session, args, {
    ...options,
    timeoutMs: options?.timeoutMs ?? 30_000,
  });
  if (result.exitCode !== 0 && options?.allowFailure !== true) {
    throw new AppError('COMMAND_FAILED', 'Limrun Android ADB command failed', {
      command: result.command.join(' '),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

export async function ensureAndroidPortReverse(
  session: LimrunAndroidSession,
  options: {
    devicePort: number;
    hostPort: number;
    name: string;
  },
): Promise<void> {
  await getLimrunAndroidPortReverse(session).ensure(
    {
      local: tcpEndpoint(options.devicePort),
      remote: tcpEndpoint(options.hostPort),
      ownerId: options.name,
    },
    { timeoutMs: 30_000 },
  );
}

export async function removeAndroidPortReverse(
  session: LimrunAndroidSession,
  devicePort: number,
): Promise<void> {
  await getLimrunAndroidPortReverse(session)
    .remove(tcpEndpoint(devicePort), { timeoutMs: 10_000 })
    .catch(() => {});
}

export async function cleanupAndroidAdbTunnel(session: LimrunAndroidSession): Promise<void> {
  const serial = session.adbSerial;
  if (serial) {
    await runLimrunAndroidAdbCommand(session, ['reverse', '--remove-all'], {
      allowFailure: true,
      timeoutMs: 10_000,
    }).catch(() => {});
    await runCmd('adb', ['disconnect', serial], {
      allowFailure: true,
      timeoutMs: 10_000,
    }).catch(() => {});
  }
  session.portReverse = undefined;
  session.adbTunnel?.close();
  session.adbTunnel = undefined;
  session.adbSerial = undefined;
}

function getLimrunAndroidPortReverse(session: LimrunAndroidSession) {
  if (session.portReverse) return session.portReverse;
  session.portReverse = createAndroidPortReverseManager(
    async (args, options) => await runLimrunAndroidAdbCommand(session, args, options),
  );
  return session.portReverse;
}

async function runLimrunAndroidAdbCommand(
  session: LimrunAndroidSession,
  args: string[],
  options?: AndroidAdbExecutorOptions,
) {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const command = ['adb', '-s', serial, ...args];
  const result = await runCmd(command[0]!, command.slice(1), {
    ...options,
    timeoutMs: options?.timeoutMs ?? 30_000,
  });
  return { ...result, command };
}

function tcpEndpoint(port: number): `tcp:${number}` {
  return `tcp:${port}`;
}

async function ensurePersistentAndroidAdbSerial(session: LimrunAndroidSession): Promise<string> {
  if (session.adbTunnel && session.adbSerial) return session.adbSerial;
  const tunnel = await session.client.startAdbTunnel();
  const serial = `${tunnel.address.address}:${tunnel.address.port}`;
  session.adbTunnel = tunnel;
  session.adbSerial = serial;
  return serial;
}
