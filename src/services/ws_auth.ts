import crypto from "node:crypto";
import { env } from "../config.js";

function b64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function timingSafeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function signWsTicket(tsSec: number, nonce: string): string {
  const msg = `${tsSec}.${nonce}`;
  const sig = crypto.createHmac("sha256", env.WS_TOKEN).update(msg).digest();
  return `${tsSec}.${nonce}.${b64url(sig)}`;
}

// replay cache (in-memory)
const seen = new Map<string, number>(); // key -> expiresAtMs

function cleanupSeen() {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
}

export function verifyWsTicket(ticket: string | null): { ok: true } | { ok: false; reason: string } {
  if (!ticket) return { ok: false, reason: "missing_ticket" };

  const parts = ticket.split(".");
  if (parts.length !== 3) return { ok: false, reason: "bad_format" };

  const [tsStr, nonce, sig] = parts;

  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "bad_ts" };
  if (!nonce || nonce.length < 8) return { ok: false, reason: "bad_nonce" };
  if (!sig || sig.length < 16) return { ok: false, reason: "bad_sig" };

  const nowSec = Math.floor(Date.now() / 1000);
  const maxDelta = env.WS_TTL_SEC + env.WS_SKEW_SEC;
  if (Math.abs(nowSec - ts) > maxDelta) return { ok: false, reason: "expired" };

  const expectedSig = signWsTicket(ts, nonce).split(".")[2]!;
  if (!timingSafeEq(expectedSig, sig)) return { ok: false, reason: "invalid_sig" };

  // replay protection for short window
  cleanupSeen();
  const key = `${ts}.${nonce}`;
  if (seen.has(key)) return { ok: false, reason: "replay" };
  const ttlMs = (env.WS_TTL_SEC + env.WS_SKEW_SEC) * 1000;
  seen.set(key, Date.now() + ttlMs * 2);

  return { ok: true };
}