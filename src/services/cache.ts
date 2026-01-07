import { LRUCache } from "lru-cache";

export function makeCache<T>(ttlMs: number) {
  return new LRUCache<string, { v: T; exp: number }>({
    max: 5000,
  });
}

export function getCached<T>(c: LRUCache<string, { v: T; exp: number }>, k: string): T | null {
  const hit = c.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    c.delete(k);
    return null;
  }
  return hit.v;
}

export function setCached<T>(c: LRUCache<string, { v: T; exp: number }>, k: string, v: T, ttlMs: number) {
  c.set(k, { v, exp: Date.now() + ttlMs });
}