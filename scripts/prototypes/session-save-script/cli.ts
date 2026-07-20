import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { applyInput, initialState, type PrototypeState } from './model.ts';

const COMMANDS = [
  'open [app] [--save-script=<path>]',
  'navigate',
  'action <one .ad command>',
  'session save-script [--force]',
  'replay <path>',
  'close [--save-script=<path>]',
  'reset',
  'quit',
];

function render(state: PrototypeState): void {
  stdout.write('\u001B[2J\u001B[H');
  stdout.write('SESSION SAVE-SCRIPT — THROWAWAY API LAB\n');
  stdout.write('Question: does saving open-to-screen-X from the active session feel coherent?\n\n');

  stdout.write('ACTIVE SESSION\n');
  if (!state.session) {
    stdout.write('  none\n');
  } else {
    stdout.write(`  app: ${state.session.app}\n`);
    const publication = state.session.publication;
    stdout.write(`  script publication: ${publication.state}`);
    if ('path' in publication) stdout.write(` → ${publication.path}`);
    stdout.write('\n');
    stdout.write('  recorded history:\n');
    state.session.history.forEach((entry, index) => {
      stdout.write(`    ${String(index + 1).padStart(2, ' ')}. [${entry.kind}] ${entry.line}\n`);
    });
  }

  stdout.write('\nSAVED SCRIPTS (in memory only)\n');
  const artifacts = Object.entries(state.savedScripts);
  if (artifacts.length === 0) {
    stdout.write('  none\n');
  } else {
    for (const [path, artifact] of artifacts) {
      stdout.write(`  ${path} [open → destination]\n`);
      artifact.lines.forEach((line) => stdout.write(`    ${line}\n`));
    }
  }

  stdout.write(`\nLAST RESULT [${state.outcome.kind.toUpperCase()}]\n  ${state.outcome.message}\n`);
  stdout.write('\nCOMMANDS\n');
  stdout.write(`  ${COMMANDS.join('\n  ')}\n\n`);
}

const readline = createInterface({ input: stdin, output: stdout });
let state = initialState;

try {
  while (true) {
    render(state);
    const input = await readline.question('> ');
    if (['quit', 'exit'].includes(input.trim())) break;
    state = applyInput(state, input);
  }
} finally {
  readline.close();
  stdout.write('\nPrototype ended; no files or device state were changed.\n');
}
