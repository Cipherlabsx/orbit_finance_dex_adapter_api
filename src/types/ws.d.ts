import "fastify";
import type { createTradeStore } from "../services/trades_indexer.js";
import type { createWsHub } from "../services/ws.js";

declare module "fastify" {
  interface FastifyInstance {
    dexKey: string;
    programId: string;
    tradeStore: ReturnType<typeof createTradeStore>;
    poolsList: string[];
    wsHub: ReturnType<typeof createWsHub>;
  }
}