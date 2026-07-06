import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { AgentDeviceClient, AgentDeviceClientConfig } from '../client/client-types.ts';
import type { CliFlags } from '../cli/parser/cli-flags.ts';
import { runCliCommandWithOutput } from '../commands/cli-runner.ts';
import type { RequestProgressSink } from '../daemon/request-progress.ts';
import { formatToolError } from '../mcp/router.ts';
import type {
  AcpContentBlock,
  AcpImageContent,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
} from './contracts.ts';
import { applyStickyFlags, parsePromptCommandLines, type RunnableLine } from './prompt-lines.ts';
import { nextToolCallId, type AcpSessionState } from './session-state.ts';
import { toolKindForCommand } from './tool-kinds.ts';

export type AcpUpdateSink = (update: AcpSessionUpdate) => void;

type RunCommandLine = typeof runCliCommandWithOutput;

export type PromptRunnerDeps = {
  runCommandLine?: RunCommandLine;
  createClient?: (
    config: AgentDeviceClientConfig,
    onProgress: RequestProgressSink,
  ) => Promise<AgentDeviceClient>;
  readImageFile?: (path: string) => AcpImageContent | undefined;
};

export type PromptRunner = {
  runPrompt: (params: {
    session: AcpSessionState;
    promptText: string;
    sendUpdate: AcpUpdateSink;
  }) => Promise<AcpStopReason>;
};

export function createPromptRunner(deps: PromptRunnerDeps = {}): PromptRunner {
  const runCommandLine = deps.runCommandLine ?? runCliCommandWithOutput;
  const createClient = deps.createClient ?? createProgressForwardingClient;
  const readImageFile = deps.readImageFile ?? readLocalImageFile;

  return {
    runPrompt: async ({ session, promptText, sendUpdate }) => {
      const lines = parsePromptCommandLines(promptText, { cwd: session.cwd });
      if (!lines.some((line) => line.kind === 'command')) {
        sendUpdate(agentMessage(refusalText(lines.length)));
        return 'refusal';
      }
      const outcomes: string[] = [];
      for (const line of lines) {
        if (session.cancelled) return 'cancelled';
        if (line.kind === 'error') {
          sendParseErrorToolCall(session, line, sendUpdate);
          outcomes.push(`✗ ${line.line} — ${line.error}`);
          continue;
        }
        Object.assign(session.sticky, line.providedSticky);
        outcomes.push(
          await runCommandToolCall({
            session,
            line,
            sendUpdate,
            deps: {
              runCommandLine,
              createClient,
              readImageFile,
            },
          }),
        );
        if (session.cancelled) return 'cancelled';
      }
      sendUpdate(agentMessage(outcomes.join('\n')));
      return 'end_turn';
    },
  };
}

async function runCommandToolCall(params: {
  session: AcpSessionState;
  line: RunnableLine;
  sendUpdate: AcpUpdateSink;
  deps: Required<PromptRunnerDeps>;
}): Promise<string> {
  const { session, line, sendUpdate, deps } = params;
  const flags = applyStickyFlags(line, session.sticky);
  const toolCallId = nextToolCallId(session);
  sendUpdate({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: line.line,
    kind: toolKindForCommand(line.command),
    status: 'in_progress',
    rawInput: { command: line.command, positionals: line.positionals },
  });
  const onProgress: RequestProgressSink = (event) => {
    if (event.type !== 'command') return;
    sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: [textContent(event.message)],
    });
  };
  try {
    const client = await deps.createClient(clientConfigFromFlags(flags, session.cwd), onProgress);
    const { result, cliOutput } = await deps.runCommandLine({
      client,
      command: line.command,
      positionals: line.positionals,
      flags,
    });
    sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: commandResultContent({ line, result, text: cliOutput?.text ?? undefined, deps }),
      ...rawOutputUpdate(line, result),
    });
    return `✓ ${line.line}`;
  } catch (error) {
    // Same code + hint + supportedOn rendering the MCP tool results use.
    const message = formatToolError(error);
    sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [textContent(message)],
    });
    return `✗ ${line.line} — ${firstLine(message)}`;
  }
}

function sendParseErrorToolCall(
  session: AcpSessionState,
  line: { line: string; error: string },
  sendUpdate: AcpUpdateSink,
): void {
  const toolCallId = nextToolCallId(session);
  sendUpdate({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: line.line,
    kind: 'other',
    status: 'in_progress',
  });
  sendUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'failed',
    content: [textContent(line.error)],
  });
}

function rawOutputUpdate(line: RunnableLine, result: unknown): { rawOutput?: unknown } {
  if (line.command === 'snapshot' || line.command === 'find') return {};
  return { rawOutput: result };
}

function commandResultContent(params: {
  line: RunnableLine;
  result: unknown;
  text: string | undefined;
  deps: Required<PromptRunnerDeps>;
}): AcpToolCallContent[] {
  const text = params.text ?? JSON.stringify(params.result, null, 2);
  const content: AcpToolCallContent[] = [textContent(text)];
  const image = screenshotImageContent(params.line, params.result, params.deps.readImageFile);
  if (image) content.push({ type: 'content', content: image });
  return content;
}

/**
 * Best-effort inline preview for screenshots: attach the image when the
 * result's artifact path is a readable local file. Remote daemons (path not
 * local) and oversized captures silently fall back to the text path.
 */
function screenshotImageContent(
  line: RunnableLine,
  result: unknown,
  readImageFile: (path: string) => AcpImageContent | undefined,
): AcpImageContent | undefined {
  if (line.command !== 'screenshot') return undefined;
  if (!result || typeof result !== 'object') return undefined;
  const path = (result as Record<string, unknown>).path;
  if (typeof path !== 'string' || path.length === 0) return undefined;
  return readImageFile(path);
}

const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function readLocalImageFile(path: string): AcpImageContent | undefined {
  const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) return undefined;
  try {
    if (statSync(path).size > MAX_INLINE_IMAGE_BYTES) return undefined;
    return { type: 'image', data: readFileSync(path).toString('base64'), mimeType };
  } catch {
    return undefined;
  }
}

async function createProgressForwardingClient(
  config: AgentDeviceClientConfig,
  onProgress: RequestProgressSink,
): Promise<AgentDeviceClient> {
  const [{ createAgentDeviceClient }, { sendToDaemon }] = await Promise.all([
    import('../client/client.ts'),
    import('../daemon/client/daemon-client.ts'),
  ]);
  type DaemonSendRequest = Parameters<typeof sendToDaemon>[0];
  return createAgentDeviceClient(config, {
    // Same client-request-to-daemon-request cast the CLI transport performs in
    // sendClientRequestToCliTransport (src/cli.ts).
    transport: async (req) =>
      await sendToDaemon(
        { ...req, meta: { ...req.meta, requestProgress: 'command' } } as DaemonSendRequest,
        { onProgress },
      ),
  });
}

/**
 * Lean per-line client config: session/target scoping plus the remote-daemon
 * fields that config files can inject. Remote connection materialization and
 * lock-policy binding stay CLI-only.
 */
function clientConfigFromFlags(flags: CliFlags, cwd: string): AgentDeviceClientConfig {
  return {
    session: flags.session,
    stateDir: flags.stateDir,
    daemonBaseUrl: flags.daemonBaseUrl,
    daemonAuthToken: flags.daemonAuthToken,
    daemonTransport: flags.daemonTransport,
    daemonServerMode: flags.daemonServerMode,
    tenant: flags.tenant,
    cwd,
    cost: flags.cost,
    responseLevel: flags.responseLevel,
  };
}

function refusalText(lineCount: number): string {
  if (lineCount === 0) {
    return 'No command lines found in the prompt. Send one agent-device command per line, e.g. "devices" or "snapshot -i --platform ios".';
  }
  return 'No runnable agent-device command lines found in the prompt. Send one command per line, e.g. "devices" or "snapshot -i --platform ios".';
}

function agentMessage(text: string): AcpSessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function textContent(text: string): AcpToolCallContent {
  return { type: 'content', content: { type: 'text', text } satisfies AcpContentBlock };
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}
