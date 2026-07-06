import {
  createMcpPayloadQueue,
  runStdioJsonRpcServer,
  writeJsonRpcMessage,
} from '../mcp/server.ts';
import { createAcpRouter, type AcpRouter } from './router.ts';

/**
 * Stdio ACP agent: newline-delimited JSON-RPC 2.0, the same framing (and the
 * same decoder/serialized-queue transport) as the MCP server. The one ACP
 * twist is that `session/cancel` must take effect while a `session/prompt` is
 * holding the queue, so cancel notifications are intercepted at the decoder
 * sink and never enter the queue.
 */
export async function runAgentDeviceAcpServer(): Promise<void> {
  const router = createAcpRouter({ sendNotification: writeJsonRpcMessage });
  const queue = createMcpPayloadQueue({
    handlePayload: router.handleAcpPayload,
    write: writeJsonRpcMessage,
  });
  await runStdioJsonRpcServer({
    sink: createAcpPayloadSink(router, queue.push),
    write: writeJsonRpcMessage,
    idle: queue.idle,
  });
}

export function createAcpPayloadSink(
  router: Pick<AcpRouter, 'markSessionCancelled'>,
  push: (payload: unknown) => void,
): (payload: unknown) => void {
  return (payload) => {
    if (isSessionCancelNotification(payload)) {
      router.markSessionCancelled(payload);
      return;
    }
    push(payload);
  };
}

function isSessionCancelNotification(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.method === 'session/cancel' && record.id === undefined;
}
