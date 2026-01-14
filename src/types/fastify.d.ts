import "fastify";

import type { TradeStore } from "../services/trades_indexer.js";
import type { VolumeStore } from "../services/volume_aggregator.js";
import type { CandleStore } from "../services/candle_aggregator.js";
import type { WsHub } from "../services/ws.js";

declare module "fastify" {
  interface FastifyInstance {
    dexKey: string;
    programId: string;

    tradeStore: TradeStore;
    poolsList: string[];

    wsHub: WsHub;

    volumeStore: VolumeStore;
    candleStore: CandleStore;
  }
}