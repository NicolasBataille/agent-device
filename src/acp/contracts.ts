// Hand-rolled ACP (Agent Client Protocol) v1 wire types for the subset this
// deterministic agent implements: initialize, session/new, session/prompt,
// session/cancel, and outbound session/update notifications. Shapes follow the
// official v1 JSON schema (https://agentclientprotocol.com); content blocks are
// MCP-compatible by design.

export const ACP_PROTOCOL_VERSION = 1;

export type AcpTextContent = { type: 'text'; text: string };
export type AcpImageContent = { type: 'image'; data: string; mimeType: string };
export type AcpContentBlock = AcpTextContent | AcpImageContent;

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export type AcpToolCallContent = { type: 'content'; content: AcpContentBlock };

export type AcpToolCallUpdateFields = {
  toolCallId: string;
  status?: AcpToolCallStatus;
  title?: string;
  kind?: AcpToolKind;
  content?: AcpToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type AcpAvailableCommand = { name: string; description: string };

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | ({
      sessionUpdate: 'tool_call';
      status: AcpToolCallStatus;
      kind: AcpToolKind;
    } & AcpToolCallUpdateFields)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdateFields)
  | { sessionUpdate: 'available_commands_update'; availableCommands: AcpAvailableCommand[] };

export type AcpSessionNotification = { sessionId: string; update: AcpSessionUpdate };

export type AcpInitializeResponse = {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  };
  authMethods: never[];
  agentInfo: { name: string; version: string };
};

export type AcpPromptResponse = { stopReason: AcpStopReason };
