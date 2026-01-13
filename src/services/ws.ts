import type { Trade } from "./trades_indexer.js";

type Client = { send: (data: string) => void };
const clients = new Set<Client>();

export function wsRegister(client: Client) {
  clients.add(client);
  return () => clients.delete(client);
}

export function wsBroadcastTrade(t: Trade) {
  const msg = JSON.stringify({ type: "trade", trade: t });
  for (const c of clients) {
    try { c.send(msg); } catch { /* ignore */ }
  }
}