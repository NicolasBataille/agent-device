import path from 'node:path';
import { AppError } from '../utils/errors.ts';

export function resolveIosTarget(app: string): string {
  const normalized = app.trim().toLowerCase();
  if (normalized === 'settings') return 'com.apple.Preferences';
  return app;
}

export function isAndroidSettingsTarget(app: string): boolean {
  const normalized = app.trim().toLowerCase();
  return normalized === 'settings' || normalized === 'com.android.settings';
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function inferAppNameFromPath(appPath: string): string | undefined {
  const base = path.basename(appPath).replace(/\.(?:app|ipa|apk|aab|zip)$/i, '');
  return base || undefined;
}

export function inferAndroidAppName(packageName: string): string | undefined {
  const segments = packageName.split('.').filter(Boolean);
  const last = segments.at(-1);
  return last ? last.replace(/[_-]+/g, ' ') : undefined;
}

export function buildAndroidAssetName(
  packageName: string | undefined,
  artifactPath: string,
): string {
  const extension = path.extname(artifactPath) || '.apk';
  const prefix = packageName?.replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'android-app';
  return `${prefix}${extension}`;
}

export function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
}

export function readLocalhostUrlPort(value: string): number | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '::1' &&
    hostname !== '[::1]'
  ) {
    return undefined;
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return port;
}

export function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
