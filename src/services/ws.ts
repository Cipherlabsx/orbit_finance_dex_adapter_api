import WebSocket from "ws";

/**
 * JSON-safe types
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * Trade payload (what the frontend expects)
 */
export type DexTrade = {
  signature: string;
  slot: number | null;
  blockTime: number | null; // seconds
  pool: string;

  user: string | null;

  inMint: string | null;
  outMint: string | null;

  amountIn: string | null; // atoms
  amountOut: string | null; // atoms
};

/**
 * Event payload (what the frontend expects)
 * NOTE: `event.data` is JsonObject (no null). If you have "no data", omit it.
 */
export type DexEvent = {
  signature: string;
  slot: number | null;
  blockTime: number | null; // seconds
  pool?: string;

  event: {
    name: string;
    data?: JsonObject;
  };
};

/**
 * Outbound WebSocket message types
 */
export type WsHelloMessage = {
  type: "hello";
  programId: string;
  ts: number;
};

export type WsTradeMessage = {
  type: "trade";
  pool: string;
  data: DexTrade;
};

export type WsEventMessage = {
  type: "event";
  pool?: string;
  data: DexEvent;
};

export type WsSnapshotMessage = {
  type: "snapshot";
  pool: string;
  trades: DexTrade[];
  ts: number;
};

export type WsOutboundMessage = WsHelloMessage | WsTradeMessage | WsEventMessage | WsSnapshotMessage;

/**
 * Socket with Orbit metadata (subscriptions)
 */
export type OrbitSocket = WebSocket & {
  __orbitPools?: Set<string>;
};

/**
 * WebSocket Hub interface
 */
export type WsHub = {
  add(ws: OrbitSocket): void;
  remove(ws: OrbitSocket): void;
  broadcast(msg: WsOutboundMessage): void;
  size(): number;
};

/**
 * Extract pool from a WS message (for routing)
 */
function extractPool(msg: WsOutboundMessage): string | null {
  if (msg.type === "trade") return msg.pool;
  if (msg.type === "snapshot") return msg.pool;

  if (msg.type === "event") {
    // Prefer explicit pool first, then try to infer from event.data
    const direct = msg.pool ?? msg.data.pool ?? null;
    if (direct) return direct;

    const data = msg.data.event.data;
    if (!data) return null;

    const pool = data["pool"];
    if (typeof pool === "string") return pool;

    const pairId = data["pairId"];
    if (typeof pairId === "string") return pairId;

    const poolId = data["poolId"];
    if (typeof poolId === "string") return poolId;

    return null;
  }

  // hello has no pool
  return null;
}

/**
 * Hub implementation (subscription-aware broadcast)
 */
export function createWsHub(): WsHub {
  const clients = new Set<OrbitSocket>();

  return {
    add(ws) {
      clients.add(ws);
    },

    remove(ws) {
      clients.delete(ws);
    },

    broadcast(msg) {
      const encoded = JSON.stringify(msg);
      const pool = extractPool(msg);

      for (const ws of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;

        // Global message (hello, etc.)
        if (!pool) {
          ws.send(encoded);
          continue;
        }

        // No subscriptions -> skip
        const subs = ws.__orbitPools;
        if (!subs || subs.size === 0) continue;

        // Send only to subscribed pools
        if (subs.has(pool)) {
          ws.send(encoded);
        }
      }
    },

    size() {
      return clients.size;
    },
  };
}