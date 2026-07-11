import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { runAndroidAdb } from './adb.ts';

const ANDROID_DISPLAY_ROTATIONS = [0, 1, 2, 3] as const;
const ANDROID_DEFAULT_DISPLAY_ID = 0;
type AndroidDisplayRotation = (typeof ANDROID_DISPLAY_ROTATIONS)[number];

export async function getAndroidGestureViewport(device: DeviceInfo): Promise<Rect> {
  // Unlike `wm size` Physical size, DisplayInfo.real is the current logical display size.
  const result = await runAndroidAdb(device, ['shell', 'cmd', 'display', 'get-displays']);
  const geometry = parseAndroidDisplayGeometry(result.stdout);
  return { x: 0, y: 0, width: geometry.width, height: geometry.height };
}

export function parseAndroidDisplayGeometry(output: string): {
  width: number;
  height: number;
  rotation: AndroidDisplayRotation;
} {
  const displayLine = output
    .split(/\r?\n/)
    .find((line) => line.includes(`Display id ${ANDROID_DEFAULT_DISPLAY_ID}:`));
  const sizeMatch = displayLine?.match(/\breal\s+(\d+)\s+x\s+(\d+)\b/);
  const rotationMatch = displayLine?.match(/\brotation\s+(\d+)\b/);
  if (!sizeMatch || !rotationMatch) {
    throw new AppError(
      'COMMAND_FAILED',
      'Unable to read current Android display geometry from cmd display get-displays',
    );
  }

  const width = Number(sizeMatch[1]);
  const height = Number(sizeMatch[2]);
  const rotation = Number(rotationMatch[1]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !isAndroidDisplayRotation(rotation)
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android display geometry returned an invalid size or rotation',
    );
  }

  return { width, height, rotation };
}

function isAndroidDisplayRotation(value: number): value is AndroidDisplayRotation {
  return (ANDROID_DISPLAY_ROTATIONS as readonly number[]).includes(value);
}
