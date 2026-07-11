import assert from 'node:assert/strict';
import { test } from 'vitest';
import { promises as fs } from 'node:fs';
import { getAndroidGestureViewport, parseAndroidDisplayGeometry } from '../display-geometry.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

test.each([
  [
    'portrait',
    'Displays:\nDisplay id 0: DisplayInfo{"Built-in Screen", real 1080 x 1920, rotation 0, type INTERNAL}',
    { width: 1080, height: 1920, rotation: 0 },
  ],
  [
    'landscape',
    'Displays:\nDisplay id 0: DisplayInfo{"Built-in Screen", real 1920 x 1080, rotation 1, type INTERNAL}',
    { width: 1920, height: 1080, rotation: 1 },
  ],
  [
    'reverse landscape',
    'Displays:\nDisplay id 0: DisplayInfo{"Built-in Screen", real 1920 x 1080, rotation 3, type INTERNAL}',
    { width: 1920, height: 1080, rotation: 3 },
  ],
] as const)('parses %s current display geometry', (_orientation, output, expected) => {
  assert.deepEqual(parseAndroidDisplayGeometry(output), expected);
});

test('gesture viewport uses one current-display subprocess and does not query accessibility', async () => {
  await withScriptedAdb(
    'agent-device-android-display-geometry-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "display" ] && [ "$4" = "get-displays" ]; then',
      '  echo "Displays:"',
      '  echo "Display id 0: DisplayInfo{\\"Built-in Screen\\", real 1920 x 1080, rotation 1, type INTERNAL}"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      assert.deepEqual(await getAndroidGestureViewport(device), {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
      const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(args, ['-s', 'emulator-5554', 'shell', 'cmd', 'display', 'get-displays']);
    },
  );
});
