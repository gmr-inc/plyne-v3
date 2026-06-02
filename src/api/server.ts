/**
 * Minimal HTTP server: health probe + MCP endpoint.
 *
 * v2 had ~20 routes (webhooks, intake, audit, telemetry). v3 only needs
 * health (for pm2 + Hetzner uptime monitoring) and the MCP endpoint
 * (for operator tools to introspect orchestrator state).
 */
import express from "express";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { handleMcpRequest } from "../mcp/server.js";

const env = loadEnv();

export function startApi(): void {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "plyne-v3", model: env.PLYNE_CLAUDE_MODEL });
  });

  // MCP endpoint — handler is async; wrap in next() to surface errors.
  app.all("/mcp", (req, res, next) => {
    handleMcpRequest(req, res).catch(next);
  });

  app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, "api: listening");
  });
}
