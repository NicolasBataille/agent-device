import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Limrun from '@limrun/api';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '../provider-device-runtime.ts';
import { runCmd } from '../utils/exec.ts';
import { AppError } from '../utils/errors.ts';
import { runLimrunAndroidAdb } from './limrun-android-adb.ts';
import type { LimrunAndroidSession, LimrunIosSession } from './limrun-session.ts';
import {
  buildAndroidAssetName,
  inferAndroidAppName,
  inferAppNameFromPath,
  normalizeOptionalString,
} from './limrun-utils.ts';

export async function installLimrunIosApp(
  limrun: Limrun,
  session: LimrunIosSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult> {
  const prepared = await prepareLimrunIosAsset(installablePath);
  try {
    const asset = await limrun.assets.getOrUpload({
      path: prepared.uploadPath,
      name: prepared.assetName,
    });
    const result = await session.client.installApp(asset.signedDownloadUrl, {
      md5: asset.md5,
      launchMode: options?.relaunch ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
    });
    const bundleId = normalizeOptionalString(result.bundleId) ?? options?.appIdentifierHint;
    return {
      ...(bundleId ? { bundleId, launchTarget: bundleId } : {}),
      appName: inferAppNameFromPath(installablePath),
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function installLimrunAndroidApp(
  limrun: Limrun,
  session: LimrunAndroidSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult> {
  const packageName = normalizeOptionalString(options?.packageNameHint);
  if (options?.relaunch && packageName) {
    await runLimrunAndroidAdb(session, ['shell', 'am', 'force-stop', packageName], {
      allowFailure: true,
    });
  }
  const asset = await limrun.assets.getOrUpload({
    path: installablePath,
    name: buildAndroidAssetName(packageName, installablePath),
  });
  await session.client.sendAsset(asset.signedDownloadUrl);
  return {
    ...(packageName ? { packageName, launchTarget: packageName } : {}),
    ...(packageName ? { appName: inferAndroidAppName(packageName) } : {}),
  };
}

async function prepareLimrunIosAsset(artifactPath: string): Promise<{
  uploadPath: string;
  assetName: string;
  cleanup: () => Promise<void>;
}> {
  const stat = await fs.promises.stat(artifactPath);
  if (!stat.isDirectory()) {
    return {
      uploadPath: artifactPath,
      assetName: path.basename(artifactPath),
      cleanup: async () => {},
    };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-device-limrun-ios-app-'));
  const zipPath = path.join(tempDir, `${path.basename(artifactPath)}.zip`);
  const result = await runCmd('zip', ['-qr', zipPath, path.basename(artifactPath)], {
    cwd: path.dirname(artifactPath),
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw new AppError('COMMAND_FAILED', 'Failed to package iOS .app for Limrun install', {
      command: ['zip', '-qr', zipPath, path.basename(artifactPath)].join(' '),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return {
    uploadPath: zipPath,
    assetName: path.basename(zipPath),
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
}
