/**
 * Plyne v3 entry point.
 *
 * Boot order:
 *   1. Load env (fails fast if mandatory keys missing).
 *   2. Start HTTP API (health + MCP).
 *   3. Start the runner daemon loop.
 */
import { loadEnv } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startApi } from "./api/server.js";
import { startRunner, stopRunner } from "./orchestrator/runner.js";
import { startIngestion, stopIngestion } from "./ingestion/index.js";

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info(
    {
      mode: env.PLYNE_MODE,
      model: env.PLYNE_CLAUDE_MODEL,
      extendedThinking: env.PLYNE_EXTENDED_THINKING,
      taskPrefix: env.PLYNE_V3_TASK_PREFIX
    },
    "plyne-v3 boot"
  );

  startApi();

  if (env.PLYNE_MODE === "smoke") {
    // One-shot mode for V3-TEST smoke runs. The smoke script imports the
    // runner directly; here we just keep the API alive long enough for it
    // to be probed if needed.
    logger.info("plyne-v3 in smoke mode — runner loop NOT started");
    return;
  }

  startRunner();

  if (env.PLYNE_INGESTION_ENABLED) {
    startIngestion();
  } else {
    logger.info("ingestion: disabled via PLYNE_INGESTION_ENABLED=false");
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, "plyne-v3 shutting down");
    stopRunner();
    stopIngestion();
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
