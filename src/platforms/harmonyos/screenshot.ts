import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sh } from '@agent-device/kernel/shell';
import { runHarmonyHdc, runHarmonyShell } from './hdc.ts';

export async function screenshotHarmony(device: DeviceInfo, outPath: string): Promise<void> {
  const remotePath = `/data/local/tmp/agent-device-screen-${randomUUID()}.jpeg`;
  try {
    await runHarmonyShell(device, [...sh.lits('snapshot_display', '-f'), sh.arg(remotePath)], {
      timeoutMs: 15_000,
    });
    await runHarmonyHdc(device, ['file', 'recv', remotePath, outPath], { timeoutMs: 15_000 });
    const data = await fs.readFile(outPath);
    if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
      throw new AppError('COMMAND_FAILED', 'HarmonyOS screenshot is not a JPEG file');
    }
  } finally {
    await runHarmonyShell(device, [...sh.lits('rm', '-f'), sh.arg(remotePath)], {
      allowFailure: true,
    }).catch(() => {});
  }
}
