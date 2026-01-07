import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "./config.js";

export const connection = new Connection(env.SOLANA_RPC_URL, {
  commitment: "confirmed",
});

export const PROGRAM_ID = new PublicKey(env.ORBIT_PROGRAM_ID);

export const pk = (v: string) => new PublicKey(v);

export const now = () => Math.floor(Date.now() / 1000);