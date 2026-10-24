import type { LocatorIdentity } from "@/services/official/locator/access";
import {
  createPositionStream,
  type PositionStreamCloseReason,
} from "@/services/official/locator/stream";
import type { Bindings } from "@/types/app";

import { serializeLocatorError } from "./helpers";

function classifyClientClose(event: CloseEvent): PositionStreamCloseReason {
  if (event.reason === "locator stopped") {
    return "client-stopped";
  }
  if (event.reason === "locator disposed" || event.reason === "page hidden") {
    return "page-lifecycle";
  }
  if (event.reason === "locator upstream state changed") {
    return "client-recovery";
  }
  return "client-closed";
}

export function bridgePositionStream(
  server: WebSocket,
  env: Bindings,
  options: {
    resolveIdentity(): Promise<LocatorIdentity>;
    includeBinding: boolean;
    requestId: string;
    schedule(task: Promise<unknown>): void;
  },
): void {
  const stream = createPositionStream({ resolveIdentity: options.resolveIdentity }, env, {
    onEvent(event) {
      let payload: unknown = event;
      if (event.type === "error") {
        payload = {
          type: "error",
          error: serializeLocatorError(event.error, options.requestId),
          requestId: options.requestId,
        };
      } else if (event.type === "position") {
        payload = {
          type: "position",
          data: event.data,
          ...(options.includeBinding ? { binding: event.binding } : {}),
        };
      }
      server.send(JSON.stringify(payload));
    },
    onClose(code, reason) {
      server.removeEventListener("close", onClientClose);
      server.removeEventListener("error", onClientError);
      server.removeEventListener("message", onClientMessage);
      try {
        server.close(code, reason);
      } catch {
        // Peer may already be closed.
      }
    },
    schedule: options.schedule,
  });
  function onClientClose(event: CloseEvent) {
    stream.close(event.code || 1000, classifyClientClose(event));
  }
  function onClientError() {
    stream.close(1011, "client-error");
  }
  function onClientMessage(event: MessageEvent) {
    if (event.data === "close") {
      stream.close(1000, "client-command");
    }
  }
  server.accept();
  server.addEventListener("close", onClientClose);
  server.addEventListener("error", onClientError);
  server.addEventListener("message", onClientMessage);
  options.schedule(stream.start());
}
