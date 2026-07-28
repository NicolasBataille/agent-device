import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { productionDependencyPolicyIssues } from './production-dependency-policy.ts';

type PackageManifest = {
  version?: string;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
};

type WorkspaceManifest = {
  nodeLinker?: string;
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageManifest = readJson<PackageManifest>('package.json');
const workspaceManifest = parse(
  fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
) as WorkspaceManifest;
const limrunManifest = readJson<PackageManifest>('node_modules/@limrun/api/package.json');
const undiciManifest = readJson<PackageManifest>('node_modules/undici/package.json');
const limrunAndroidClientPath = path.join(root, 'node_modules/@limrun/api/instance-client.mjs');
const providerSourcePath = path.join(root, 'src/providers/limrun/android.ts');

const issues = productionDependencyPolicyIssues({
  limrunSpecifier: packageManifest.dependencies?.['@limrun/api'],
  bundledDependencies: packageManifest.bundleDependencies ?? [],
  nodeLinker: workspaceManifest.nodeLinker,
  undiciOverride: workspaceManifest.overrides?.['undici@7'],
  patchedDependencies: workspaceManifest.patchedDependencies ?? {},
  installedLimrunVersion: limrunManifest.version,
  installedUndiciVersion: undiciManifest.version,
  limrunAndroidClientSource: fs.existsSync(limrunAndroidClientPath)
    ? fs.readFileSync(limrunAndroidClientPath, 'utf8')
    : undefined,
  agentDeviceLimrunAndroidSource: fs.readFileSync(providerSourcePath, 'utf8'),
});

if (issues.length > 0) {
  for (const issue of issues) process.stderr.write(`- ${issue}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Production dependency policy passed: @limrun/api ${limrunManifest.version}, bundled undici ${undiciManifest.version}.\n`,
  );
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8')) as T;
}
