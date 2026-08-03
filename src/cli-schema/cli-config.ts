import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mergeDefinedFlags } from '../utils/merge-flags.ts';
import { type CliFlags, type FlagKey } from '../commands/cli-grammar/flag-types.ts';
import { expandUserHomePath, resolveUserPath } from '../utils/path-resolution.ts';
import {
  getConfigurableOptionSpecs,
  getOptionSpec,
  parseOptionValueFromSource,
} from './option-schema.ts';
import type { ConfigTrust } from './config-trust.ts';
import { parseInstallSourceConfig } from '../utils/install-source-config.ts';
import type { EnvMap } from '../utils/env-map.ts';

export function resolveConfigBackedFlagDefaults(options: {
  command: string | null;
  cwd: string;
  cliFlags: CliFlags;
  env?: EnvMap;
}): Partial<CliFlags> {
  const env = options.env ?? process.env;
  const defaults = mergeDefinedFlags(
    {} as Partial<CliFlags>,
    loadConfigFileDefaults(resolveConfigPaths(options.cwd, options.cliFlags.config, env)),
  );
  return mergeDefinedFlags(defaults, readEnvFlagDefaults(env, options.command));
}

type ConfigFileSource = 'user' | 'project' | 'explicit';

type ConfigPath = { path: string; required: boolean; source: ConfigFileSource };

function resolveConfigPaths(
  cwd: string,
  explicitCliConfigPath: string | undefined,
  env: EnvMap,
): ConfigPath[] {
  const explicitConfig = explicitCliConfigPath ?? env.AGENT_DEVICE_CONFIG;
  if (explicitConfig) {
    return [
      { path: resolveInputPath(explicitConfig, cwd, env), required: true, source: 'explicit' },
    ];
  }
  return [
    { path: resolveUserConfigPath(env), required: false, source: 'user' },
    { path: path.resolve(cwd, 'agent-device.json'), required: false, source: 'project' },
  ];
}

function resolveUserConfigPath(env: EnvMap): string {
  return path.join(expandUserHomePath('~', { env }), '.agent-device', 'config.json');
}

function resolveInputPath(inputPath: string, cwd: string, env: EnvMap): string {
  return resolveUserPath(inputPath, { cwd, env });
}

function loadConfigFileDefaults(pathsToCheck: ConfigPath[]): Partial<CliFlags> {
  const merged: Partial<CliFlags> = {};
  for (const entry of pathsToCheck) {
    const parsed = loadSingleConfigFile(entry);
    mergeDefinedFlags(merged, parsed);
  }
  return merged;
}

function loadSingleConfigFile(entry: ConfigPath): Partial<CliFlags> {
  const { path: filePath, required } = entry;
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new AppError('INVALID_ARGS', `Config file not found: ${filePath}`);
    }
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Failed to read config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid JSON in config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_ARGS', `Config file must contain a JSON object: ${filePath}`);
  }

  return parseConfigObject(parsed as Record<string, unknown>, {
    source: entry.source,
    label: `${entry.source === 'project' ? 'project ' : ''}config file ${filePath}`,
  });
}

function parseConfigObject(
  source: Record<string, unknown>,
  origin: { source: ConfigFileSource; label: string },
): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey as FlagKey;
    const spec = getOptionSpec(key);
    if (!spec) {
      throw new AppError('INVALID_ARGS', `Unknown config key "${rawKey}" in ${origin.label}.`);
    }
    assertConfigTrust(rawKey, spec.config.trust, origin);
    if (key === 'installSource') {
      flags.installSource = parseInstallSourceConfig(rawValue, origin.label);
      continue;
    }
    (flags as Record<string, unknown>)[key] = parseOptionValueFromSource(
      spec,
      rawValue,
      origin.label,
      rawKey,
    );
  }
  return flags;
}

function assertConfigTrust(
  rawKey: string,
  trust: ConfigTrust,
  origin: { source: ConfigFileSource; label: string },
): void {
  if (trust === 'project-safe') return;
  if (trust === 'user-or-explicit-only' && origin.source !== 'project') return;
  const guidance =
    trust === 'disabled'
      ? 'This key is not supported in config files.'
      : 'Move it to ~/.agent-device/config.json, pass it with --config or AGENT_DEVICE_CONFIG, or provide it through CLI flags/environment variables.';
  throw new AppError(
    'INVALID_ARGS',
    `Config key "${rawKey}" is not allowed in ${origin.label}. ${guidance}`,
  );
}

function readEnvFlagDefaults(env: EnvMap, command: string | null): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  for (const spec of getConfigurableOptionSpecs(command)) {
    if (spec.key === 'installSource') continue;
    const envNames = spec.env.names;
    const envValue = envNames
      .map((name) => ({ name, value: env[name] }))
      .find((entry) => typeof entry.value === 'string' && entry.value.trim().length > 0);
    if (!envValue) continue;
    (flags as Record<string, unknown>)[spec.key] = parseOptionValueFromSource(
      spec,
      envValue.value as string,
      `environment variable ${envValue.name}`,
      envValue.name,
    );
  }
  return flags;
}
