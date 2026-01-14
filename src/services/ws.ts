import WebSocket from "ws";

export type WsHub = {
  add(ws: WebSocket): void;
  remove(ws: WebSocket): void;
  broadcast(payload: unknown): void;
  size(): number;
};

export function createWsHub(): WsHub {
  const clients = new Set<WebSocket>();

  return {
    add(ws) {
      clients.add(ws);
    },
    remove(ws) {
      clients.delete(ws);
    },
    broadcast(payload) {
      const msg = JSON.stringify(payload);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
    },
    size() {
      return clients.size;
    },
  };
}