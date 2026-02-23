import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Step = {
  id: string;
  script: string;
  enabled: boolean;
};

function parseBoolEnv(name: string, def = false): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function parseStepFilter(): Set<string> | null {
  const raw = (process.env.DAILY_RECONCILE_STEPS ?? "").trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

async function runScript(scriptName: string, cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  const cmd = npmExecPath ? process.execPath : "pnpm";
  const args = npmExecPath ? [npmExecPath, "run", scriptName] : ["run", scriptName];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`step ${scriptName} failed (code=${code ?? "null"} signal=${signal ?? "none"})`));
    });
  });
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const only = parseStepFilter();
  const continueOnError = parseBoolEnv("DAILY_RECONCILE_CONTINUE_ON_ERROR", false);
  const includeEvents = parseBoolEnv("DAILY_RECONCILE_INCLUDE_EVENTS", false);
  const skipTokens = parseBoolEnv("DAILY_RECONCILE_SKIP_TOKENS", false);
  const skipBins = parseBoolEnv("DAILY_RECONCILE_SKIP_BINS", false);

  const steps: Step[] = [
    { id: "sync-tokens", script: "sync-tokens", enabled: !skipTokens },
    { id: "pools", script: "backfill:pools", enabled: true },
    { id: "pool-liquidity", script: "backfill:pools:liq", enabled: true },
    { id: "pool-fee-balances", script: "backfill:pools:fee-balances", enabled: true },
    { id: "pool-bins", script: "backfill:pools:bins", enabled: !skipBins },
    { id: "events", script: "backfill:events", enabled: includeEvents },
  ].filter((s) => s.enabled && (!only || only.has(s.id) || only.has(s.script)));

  if (steps.length === 0) {
    console.log("[daily_reconcile] no steps selected");
    return;
  }

  console.log("[daily_reconcile] start", {
    at: nowIso(),
    continueOnError,
    steps: steps.map((s) => `${s.id}:${s.script}`),
  });

  const failures: Array<{ step: string; error: string }> = [];

  for (const step of steps) {
    const started = Date.now();
    console.log(`[daily_reconcile] -> ${step.id} (${step.script})`);
    try {
      await runScript(step.script, repoRoot);
      const ms = Date.now() - started;
      console.log(`[daily_reconcile] <- ${step.id} ok (${ms}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ step: step.id, error: msg });
      console.error(`[daily_reconcile] <- ${step.id} failed: ${msg}`);
      if (!continueOnError) {
        throw err;
      }
    }
  }

  console.log("[daily_reconcile] done", {
    at: nowIso(),
    failures,
  });

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[daily_reconcile] fatal", err);
  process.exit(1);
});
