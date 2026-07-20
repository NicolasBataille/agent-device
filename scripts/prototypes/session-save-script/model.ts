export type HistoryEntry = {
  kind: 'open' | 'action';
  line: string;
};

export type ActiveSession = {
  app: string;
  history: HistoryEntry[];
  recordingPath: string | null;
};

export type SavedScript = {
  lines: string[];
};

export type PrototypeState = {
  session: ActiveSession | null;
  savedScripts: Record<string, SavedScript>;
  outcome: {
    kind: 'info' | 'success' | 'error';
    message: string;
  };
};

export const initialState: PrototypeState = {
  session: null,
  savedScripts: {},
  outcome: {
    kind: 'info',
    message: 'Open an app, perform some actions, then save a reusable script.',
  },
};

function outcome(
  state: PrototypeState,
  kind: PrototypeState['outcome']['kind'],
  message: string,
): PrototypeState {
  return { ...state, outcome: { kind, message } };
}

function appendActions(state: PrototypeState, lines: string[], label: string): PrototypeState {
  if (!state.session) {
    return outcome(state, 'error', `${label} needs an active session. Run \`open <app>\` first.`);
  }

  return {
    ...state,
    session: {
      ...state.session,
      history: [
        ...state.session.history,
        ...lines.map((line): HistoryEntry => ({ kind: 'action', line })),
      ],
    },
    outcome: { kind: 'success', message: `${label} added ${lines.length} actions.` },
  };
}

function saveScript(state: PrototypeState, parts: string[]): PrototypeState {
  if (!state.session) {
    return outcome(state, 'error', 'No active session to save.');
  }

  if (!state.session.recordingPath) {
    return outcome(
      state,
      'error',
      'This session was not opened with --save-script=<path>, so its actions lack recording-time identity evidence.',
    );
  }

  const flags = parts;
  const unknownFlag = flags.find((flag) => flag !== '--force');
  if (unknownFlag) {
    return outcome(state, 'error', `Unknown flag: ${unknownFlag}`);
  }

  const path = state.session.recordingPath;
  const force = flags.includes('--force');
  if (state.savedScripts[path] && !force) {
    return outcome(
      state,
      'error',
      `${path} already exists. Add \`--force\` to replace it. The session is still active.`,
    );
  }

  const lines = state.session.history.map((entry) => entry.line);
  const actionCount = state.session.history.filter((entry) => entry.kind === 'action').length;
  if (actionCount === 0) {
    return outcome(state, 'error', 'There are no actions to save yet.');
  }

  const lastAction = state.session.history.findLast((entry) => entry.kind === 'action');
  if (!lastAction || !isDestinationGuard(lastAction.line)) {
    return outcome(
      state,
      'error',
      'Record a target-bearing `wait <selector>` destination guard before saving the script.',
    );
  }

  return {
    ...state,
    session: { ...state.session, recordingPath: null },
    savedScripts: {
      ...state.savedScripts,
      [path]: { lines },
    },
    outcome: {
      kind: 'success',
      message: `Saved ${path} from app open through the current screen. The session remains active.`,
    },
  };
}

function isDestinationGuard(line: string): boolean {
  return /^wait\s+(?!stable(?:\s|$)|\d+(?:\s|$))/.test(line);
}

function replay(state: PrototypeState, path: string | undefined): PrototypeState {
  if (!path) {
    return outcome(state, 'error', 'Usage: replay <path>');
  }

  const artifact = state.savedScripts[path];
  if (!artifact) {
    return outcome(state, 'error', `${path} has not been saved in this prototype.`);
  }

  if (state.session) {
    return outcome(
      state,
      'error',
      'Close the active session before replaying a journey from scratch.',
    );
  }

  const [openLine, ...actionLines] = artifact.lines;
  const app = openLine?.startsWith('open ') ? openLine.slice('open '.length) : 'unknown-app';
  return {
    ...state,
    session: {
      app,
      recordingPath: null,
      history: [
        { kind: 'open', line: openLine ?? `open ${app}` },
        ...actionLines.map((line): HistoryEntry => ({ kind: 'action', line })),
      ],
    },
    outcome: {
      kind: 'success',
      message: `Replayed ${path} from app open to its saved destination; the session remains active there.`,
    },
  };
}

export function applyInput(state: PrototypeState, rawInput: string): PrototypeState {
  const input = rawInput.trim();
  if (!input) return state;

  const [command, ...parts] = input.split(/\s+/);

  if (command === 'open') {
    if (state.session) {
      return outcome(
        state,
        'error',
        'A session is already active. Close it before opening another.',
      );
    }

    const recordingFlag = parts.find((part) => part.startsWith('--save-script='));
    const recordingPath = recordingFlag?.slice('--save-script='.length) || null;
    const app = parts.filter((part) => part !== recordingFlag).join(' ') || 'com.example.app';
    return {
      ...state,
      session: {
        app,
        history: [{ kind: 'open', line: `open ${app}` }],
        recordingPath,
      },
      outcome: {
        kind: 'success',
        message: recordingPath
          ? `Opened ${app} and armed recording-time identity capture for ${recordingPath}.`
          : `Opened ${app} without script recording.`,
      },
    };
  }

  if (command === 'navigate') {
    return appendActions(
      state,
      [
        'click "label=Settings"',
        'click "label=Notifications"',
        'wait "label=Notification preferences" 5000',
      ],
      'Deep navigation',
    );
  }

  if (command === 'action') {
    const line = input.slice('action'.length).trim();
    if (!line) return outcome(state, 'error', 'Usage: action <one .ad command>');
    return appendActions(state, [line], 'Custom action');
  }

  if (command === 'session' && parts[0] === 'save-script') {
    return saveScript(state, parts.slice(1));
  }

  if (command === 'replay') {
    return replay(state, parts[0]);
  }

  if (command === 'close') {
    if (!state.session) return outcome(state, 'error', 'There is no active session to close.');
    return {
      ...state,
      session: null,
      outcome: {
        kind: 'success',
        message: 'Closed the session. Previously saved scripts remain available.',
      },
    };
  }

  if (command === 'reset') {
    return {
      ...initialState,
      outcome: { kind: 'info', message: 'Prototype state reset.' },
    };
  }

  return outcome(state, 'error', `Unknown command: ${input}`);
}
