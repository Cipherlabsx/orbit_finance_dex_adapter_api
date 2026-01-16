import "fastify";

import type { TradeStore } from "../services/trades_indexer.js";
import type { VolumeStore } from "../services/volume_aggregator.js";
import type { CandleStore } from "../services/candle_aggregator.js";
import type { WsHub } from "../services/ws.js";
import type { StreamflowStakeStore } from "../services/streamflow_staking_indexer.js";
import type { FeesStore } from "../services/fees_aggregator.js";

declare module "fastify" {
  interface FastifyInstance {
    dexKey: string;
    programId: string;
    tradeStore: TradeStore;
    poolsList: string[];
    wsHub: WsHub;
    volumeStore: VolumeStore;
    candleStore: CandleStore;
    stakeStore: StreamflowStakeStore;
    feesStore: FeesStore;
  }
}