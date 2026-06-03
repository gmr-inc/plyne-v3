/**
 * Plyne v3 entry point.
 *
 * Boot order:
 *   1. Hydrate process.env: dotenv (local .env file) then Vercel API pull.
 *      This must run BEFORE any module that snapshots env at import time
 *      (logger, env.ts), so we use dynamic imports below.
 *   2. Load + Zod-validate env.
 *   3. Live-verify NOTION_TOKEN + comprehensive boot validation
 *      (GH/Anthropic/Telegram/Supabase tokens + WORKTREE_BASE).
 *   4. Assert the local repos base path exists (post-VPS-migration guard).
 *   5. Start HTTP API (health + MCP).
 *   6. Start the runner daemon loop.
 *
 * See:
 *   - src/config/vercel-env-pull.ts (Task A)
 *   - src/config/boot-validation.ts (Task B)
 *   - RESTART.md                    (Task C)
 */

async function main(): Promise<void> {
  // ─── Step 1: hydrate process.env ───────────────────────────────────
  // dotenv must run FIRST so VERCEL_TOKEN is available. We call .config()
  // explicitly rather than rely on the side-effect import inside env.ts,
  // because we need it before any other module loads.
  const dotenv = await import("dotenv");
  dotenv.config();

  const { pullVercelEnv } = await import("./config/vercel-env-pull.js");
  const pullResult = await pullVercelEnv();

  // ─── Step 2: now safe to load env (Zod) + logger ───────────────────
  const { loadEnv } = await import("./config/env.js");
  const { logger } = await import("./config/logger.js");
  const env = loadEnv();

  if (pullResult.ran) {
    logger.info(
      {
        fromVercel: pullResult.fromVercel,
        preservedLocal: pullResult.preservedLocal,
        emptyFromVercel: pullResult.emptyFromVercel
      },
      "vercel-env-pull: applied"
    );
  } else if (pullResult.error) {
    // Non-fatal — daemon proceeds with whatever .env contained.
    logger.warn({ error: pullResult.error }, "vercel-env-pull: skipped");
  } else {
    logger.debug("vercel-env-pull: gated off (PLYNE_V3_PULL_VERCEL_ENV!=true)");
  }

  logger.info(
    {
      mode: env.PLYNE_MODE,
      model: env.PLYNE_CLAUDE_MODEL,
      extendedThinking: env.PLYNE_EXTENDED_THINKING,
      taskPrefix: env.PLYNE_V3_TASK_PREFIX
    },
    "plyne-v3 boot"
  );

  // ─── Step 3: live verification (fail-fast on bad credentials) ──────
  const { verifyNotionTokenLive } = await import("./notion/client.js");
  const { runBootValidation } = await import("./config/boot-validation.js");
  await verifyNotionTokenLive();
  await runBootValidation();

  // ─── Step 4: VPS layout guard ──────────────────────────────────────
  const { assertLocalReposBase } = await import("./executor/worktree.js");
  assertLocalReposBase();
  logger.info("plyne-v3 hardening checks passed (notion token live, repos base accessible)");

  // ─── Step 5: HTTP API + MCP ────────────────────────────────────────
  const { startApi } = await import("./api/server.js");
  startApi();

  if (env.PLYNE_MODE === "smoke") {
    logger.info("plyne-v3 in smoke mode — runner loop NOT started");
    return;
  }

  // ─── Step 6: runner + ingestion ────────────────────────────────────
  const { startRunner, stopRunner, getInFlightCount } = await import("./orchestrator/runner.js");
  const { startAutoMerge, stopAutoMerge } = await import("./orchestrator/auto-merge-loop.js");
  const { startIngestion, stopIngestion } = await import("./ingestion/index.js");

  startRunner();

  // Auto-merge loop: squash-merges pr-open PRs once fully green (CI +
  // CodeRabbit). AC were already machine-verified before the PR opened
  // (ac-runner), so this is the second half of safe auto-merge. Self-gates on
  // PLYNE_V3_AUTO_MERGE (default true).
  startAutoMerge();

  // ─── plyne-app Supabase LIVE reporter (heartbeat) ──────────────────
  // Gated on the PLYNE_APP_SUPABASE_* credentials being present. When unset
  // the reporter no-ops (warn-once) and the daemon runs exactly as before —
  // only the FE's live view of daemon progress is dark. The task-status
  // mirror is wired separately inside notion/client.ts#setStatus.
  const { startHeartbeat, stopHeartbeat } = await import("./lib/supabase-reporter.js");
  if (env.PLYNE_APP_SUPABASE_URL && env.PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY) {
    startHeartbeat(getInFlightCount);
    logger.info("plyne-app supabase reporter: heartbeat + task-status mirror active");
  } else {
    logger.warn(
      "plyne-app supabase reporter: PLYNE_APP_SUPABASE_URL / PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY " +
        "unset — FE will not reflect live daemon progress. Set both on the VPS to activate."
    );
  }

  if (env.PLYNE_INGESTION_ENABLED) {
    startIngestion();
  } else {
    logger.info("ingestion: disabled via PLYNE_INGESTION_ENABLED=false");
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, "plyne-v3 shutting down");
    stopRunner();
    stopAutoMerge();
    stopIngestion();
    stopHeartbeat();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("plyne-v3 fatal boot error:", err);
  process.exit(1);
});
