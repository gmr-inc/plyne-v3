/**
 * Plyne v3 MCP server — exposes orchestrator state to external Claude Code
 * sessions (e.g. operator's chat-Claude or a teammate's IDE).
 *
 * Architecture §"Backend layout" calls for `src/mcp/server.ts` exposing
 * 5-8 tools: task.create / task.list / task.get / task.logs / task.abort.
 *
 * Implementation note: we expose this as a plain JSON-RPC-over-HTTP
 * endpoint compatible with the MCP "http" transport. A full MCP server
 * (with streaming + capabilities negotiation) is a future task; for now
 * the goal is an introspection API operator tools can poll.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { listReadyTasks, getTask, setStatus, addComment } from "../notion/client.js";
import { logger } from "../config/logger.js";

const ToolCallSchema = z.object({
  tool: z.string(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: z.record(z.string(), z.any()).default({})
});

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const tools: Record<string, { description: string; handler: ToolHandler }> = {
  "task.list": {
    description: "List ready tasks matching the V3 prefix.",
    handler: async (args) => {
      const prefix = typeof args["prefix"] === "string" ? args["prefix"] : "V3-TEST-";
      const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
      return listReadyTasks(prefix, limit);
    }
  },
  "task.get": {
    description: "Fetch one task by Notion page id.",
    handler: async (args) => {
      const id = String(args["id"] ?? "");
      if (!id) throw new Error("task.get requires `id`");
      return getTask(id);
    }
  },
  "task.create": {
    description: "Placeholder — task creation flows through Notion directly today.",
    handler: async () => ({ ok: false, reason: "creation handled by operator in Notion UI" })
  },
  "task.logs": {
    description: "Placeholder — log streaming arrives with the Supabase migration.",
    handler: async (args) => ({ ok: false, taskId: args["id"], reason: "log streaming pending" })
  },
  "task.abort": {
    description: "Flip a task to needs-operator and post an abort comment.",
    handler: async (args) => {
      const id = String(args["id"] ?? "");
      if (!id) throw new Error("task.abort requires `id`");
      const reason = String(args["reason"] ?? "aborted via MCP");
      await setStatus(id, "needs-operator");
      await addComment(id, `Plyne v3 task aborted via MCP: ${reason}`);
      return { ok: true };
    }
  }
};

export function handleMcpRequest(req: Request, res: Response): void {
  if (req.method === "GET") {
    // Discovery — list available tools so operator-side Claude can introspect.
    res.json({
      server: "plyne-v3",
      version: "0.1.0",
      tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description }))
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const parsed = ToolCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", details: parsed.error.format() });
    return;
  }
  const tool = tools[parsed.data.tool];
  if (!tool) {
    res.status(404).json({ error: `unknown tool: ${parsed.data.tool}` });
    return;
  }
  tool
    .handler(parsed.data.arguments)
    .then((result) => {
      res.json({ ok: true, tool: parsed.data.tool, result });
    })
    .catch((err: unknown) => {
      logger.error({ tool: parsed.data.tool, err }, "mcp: tool handler failed");
      res.status(500).json({ ok: false, error: String(err) });
    });
}
