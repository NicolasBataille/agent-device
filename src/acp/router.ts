import { listMcpCommandMetadata } from '../commands/command-metadata.ts';
import { jsonRpcRequestSchema, type JsonRpcId } from '../kernel/contracts.ts';
import { errorResponse, successResponse, type JsonRpcResponse } from '../mcp/router.ts';
import { readVersion } from '../utils/version.ts';
import {
  ACP_PROTOCOL_VERSION,
  type AcpContentBlock,
  type AcpInitializeResponse,
  type AcpPromptResponse,
  type AcpSessionUpdate,
} from './contracts.ts';
import { createPromptRunner, type PromptRunner } from './prompt-runner.ts';
import { createAcpSessionStore, type AcpSessionState } from './session-state.ts';

export type AcpRouter = {
  handleAcpPayload: (payload: unknown) => Promise<unknown | null>;
  markSessionCancelled: (payload: unknown) => void;
};

export function createAcpRouter(deps: {
  sendNotification: (message: unknown) => void;
  promptRunner?: PromptRunner;
  // Injectable so router tests can pin the response-before-notification order
  // without relying on real event-loop timing.
  scheduleAfterResponse?: (run: () => void) => void;
}): AcpRouter {
  const sessions = createAcpSessionStore();
  const promptRunner = deps.promptRunner ?? createPromptRunner();
  const scheduleAfterResponse = deps.scheduleAfterResponse ?? ((run) => setImmediate(run));

  const sendSessionUpdate = (sessionId: string, update: AcpSessionUpdate): void => {
    deps.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  };

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'initialize':
        return initializeResponse();
      case 'session/new':
        return newSession(params);
      case 'session/prompt':
        return await runPrompt(params);
      default:
        throw new AcpMethodNotFoundError(`Unsupported ACP method: ${method}`);
    }
  };

  const newSession = (params: unknown): { sessionId: string } => {
    const cwd = stringField(asRecord(params), 'cwd');
    const session = sessions.create(cwd);
    // The session/new response must reach the client before the first
    // notification for that session; the response is written when this handler
    // resolves (a microtask), so schedule the notification on a macrotask.
    scheduleAfterResponse(() => {
      sendSessionUpdate(session.id, {
        sessionUpdate: 'available_commands_update',
        availableCommands: listMcpCommandMetadata().map((definition) => ({
          name: definition.name,
          description: definition.description,
        })),
      });
    });
    return { sessionId: session.id };
  };

  const runPrompt = async (params: unknown): Promise<AcpPromptResponse> => {
    const record = asRecord(params);
    const session = requireSession(sessions.get(stringField(record, 'sessionId')));
    if (session.promptActive) {
      throw new AcpInvalidParamsError('A prompt is already running for this session.');
    }
    session.promptActive = true;
    session.cancelled = false;
    try {
      const stopReason = await promptRunner.runPrompt({
        session,
        promptText: readPromptText(record.prompt),
        sendUpdate: (update) => sendSessionUpdate(session.id, update),
      });
      // A cancel that lands after the last command still owns the turn: the
      // spec requires `cancelled` whenever the client sent session/cancel.
      return { stopReason: session.cancelled ? 'cancelled' : stopReason };
    } finally {
      session.promptActive = false;
    }
  };

  return {
    handleAcpPayload: async (payload) => {
      if (Array.isArray(payload)) return invalidRequestResponse(null);
      let message;
      try {
        message = jsonRpcRequestSchema.parse(payload);
      } catch {
        return invalidRequestResponse(bestEffortId(payload));
      }
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return invalidRequestResponse(message.id ?? null);
      }
      if (message.id === undefined) {
        // The server intercepts session/cancel before the queue; handling it
        // here too keeps the router correct when driven directly.
        if (message.method === 'session/cancel')
          markCancelled(sessions.get.bind(sessions), message.params);
        return null;
      }
      try {
        return successResponse(message.id, await handleRequest(message.method, message.params));
      } catch (error) {
        return errorResponse(message.id, errorCode(error), errorMessage(error));
      }
    },
    markSessionCancelled: (payload) => {
      const params = asOptionalRecord(payload)?.params;
      markCancelled(sessions.get.bind(sessions), params);
    },
  };
}

function markCancelled(
  getSession: (id: string) => AcpSessionState | undefined,
  params: unknown,
): void {
  const sessionId = asOptionalRecord(params)?.sessionId;
  if (typeof sessionId !== 'string') return;
  const session = getSession(sessionId);
  if (session) session.cancelled = true;
}

function initializeResponse(): AcpInitializeResponse {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: [],
    agentInfo: { name: 'agent-device', version: readVersion() },
  };
}

function readPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    throw new AcpInvalidParamsError('Expected prompt to be an array of content blocks.');
  }
  return prompt
    .filter(
      (block): block is Extract<AcpContentBlock, { type: 'text' }> =>
        asOptionalRecord(block)?.type === 'text' &&
        typeof asOptionalRecord(block)?.text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

function requireSession(session: AcpSessionState | undefined): AcpSessionState {
  if (!session) throw new AcpInvalidParamsError('Unknown sessionId.');
  return session;
}

function errorCode(error: unknown): number {
  if (error instanceof AcpMethodNotFoundError) return -32601;
  if (error instanceof AcpInvalidParamsError) return -32602;
  return -32603;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidRequestResponse(id: JsonRpcId): JsonRpcResponse {
  return errorResponse(id, -32600, 'Invalid JSON-RPC request.');
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (!record) throw new AcpInvalidParamsError('Expected object parameters.');
  return record;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AcpInvalidParamsError(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function bestEffortId(value: unknown): JsonRpcId {
  const id = asOptionalRecord(value)?.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}

class AcpMethodNotFoundError extends Error {}
class AcpInvalidParamsError extends Error {}
