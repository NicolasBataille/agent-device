import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempWorkspace(): { root: string; home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-config-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}
