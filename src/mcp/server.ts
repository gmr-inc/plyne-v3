/**
 * Plyne v3 MCP server — REAL (no stub).
 *
 * Exposes 5 tools + 3 resources backed by the Plyne v3 REST API.
 *
 * Transports supported:
 *   - stdio (default)        — `pnpm mcp:stdio` then `claude mcp add plyne --transport stdio --command 'tsx /path/to/server.ts'`
 *   - streamable HTTP        — `PLYNE_MCP_TRANSPORT=http pnpm mcp:http`, then `claude mcp add plyne --url http://localhost:8787/mcp`
 *
 * Auth:
 *   - PAT (dev / CI):   PLYNE_PAT=<token>
 *   - OAuth (prod):     token store at ~/.claude/mcp-credentials/plyne.json
 *
 * Spec: /tmp/plyne-v3-architecture.md (lines 167-176 + Stack Anthropic ABUSED).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  PlyneHttpClient,
  resolveAuthToken,
  resolveBaseUrl,
  TaskAbortInput,
  TaskCreateInput,
  TaskIdInput,
  TaskListInput,
  TaskLogsInput,
} from "./client.js";
import { ZodError } from "zod";

const SERVER_NAME = "plyne";
const SERVER_VERSION = "0.1.0";

/* ────────────────────────────────────────────────────────────
   Tool registry — 5 tools as per task spec Part 1.3
   ──────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "plyne.task.create",
    description:
      "Create a new Plyne v3 task. Caller supplies MCP servers, Skills, optional Computer Use, and model selection. Returns task id + URL + status.",
    inputSchema: {
      type: "object",
      required: ["title", "product", "instructions_md", "acceptance_criteria"],
      properties: {
        title: { type: "string", description: "Format: [PRODUCT-AREA-NNN] short title" },
        product: { type: "string" },
        repo: { type: "string", description: "Auto-derived from product if absent" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], default: "P2" },
        effort: { type: "string", enum: ["XS", "S", "M", "L", "XL"] },
        instructions_md: { type: "string" },
        acceptance_criteria: { type: "string" },
        po_id: { type: "string" },
        mcp_servers: {
          type: "array",
          items: { type: "string" },
          description: "MCP servers to attach to the Claude Code subprocess (github, notion, vercel, supabase, slack)",
          default: [],
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Claude Skills to preload (github-pr-review, vercel-deploy-fixer, ...)",
          default: [],
        },
        computer_use: {
          type: "boolean",
          description: "Enable Computer Use for UI testing tasks",
          default: false,
        },
        model: {
          type: "string",
          enum: ["claude-opus-4-8", "claude-sonnet-4-6", "latest"],
          default: "claude-opus-4-8",
        },
      },
    },
  },
  {
    name: "plyne.task.list",
    description: "List Plyne tasks with optional filters (status, owner, product, repo).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        owner: { type: "string" },
        product: { type: "string" },
        repo: { type: "string" },
        limit: { type: "number", default: 50, maximum: 200 },
      },
    },
  },
  {
    name: "plyne.task.get",
    description: "Fetch full Plyne task detail (instructions + AC + PR + stack config + cost).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "plyne.task.logs",
    description:
      "Fetch task execution logs. Paginated by default; pass follow=true for a tailing stream (transport-dependent).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        follow: { type: "boolean", default: false },
        since: { type: "string", description: "ISO timestamp" },
        limit: { type: "number", default: 200, maximum: 2000 },
      },
    },
  },
  {
    name: "plyne.task.abort",
    description: "Abort a running Plyne task. Reason is appended to the task history.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
] as const;

/* ────────────────────────────────────────────────────────────
   Resources — 3 as per task spec Part 1.4
   ──────────────────────────────────────────────────────────── */

const STATIC_RESOURCES = [
  {
    uri: "plyne://my-quota",
    name: "My Claude Max quota",
    description: "Current authenticated user's quota: session %, week %, plan, per-model breakdown.",
    mimeType: "application/json",
  },
  {
    uri: "plyne://team-activity",
    name: "Team activity feed",
    description: "Last 50 cross-team events (task created/done/aborted, PR merged, …).",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "plyne://tasks/{id}",
    name: "Task detail (markdown)",
    description:
      "Renders a task as markdown: header (title/status/PR), instructions, acceptance criteria, stack config, last logs.",
    mimeType: "text/markdown",
  },
];

/* ────────────────────────────────────────────────────────────
   Renderers — JSON → markdown for plyne://tasks/{id}
   ──────────────────────────────────────────────────────────── */

function renderTaskMarkdown(t: Awaited<ReturnType<PlyneHttpClient["getTask"]>>): string {
  const lines = [
    `# ${t.title}`,
    "",
    `- **id**: \`${t.id}\``,
    `- **status**: \`${t.status}\``,
    `- **product**: \`${t.product}\`  ·  **repo**: \`${t.repo}\``,
    `- **model**: \`${t.model}\`  ·  **attempts**: ${t.attempts}  ·  **cost**: $${t.cost_usd.toFixed(4)}`,
    t.pr_url ? `- **PR**: ${t.pr_url}` : "",
    "",
    "## Stack",
    `- MCP servers: ${t.mcp_servers.length ? t.mcp_servers.map((s) => `\`${s}\``).join(", ") : "_none_"}`,
    `- Skills: ${t.skills.length ? t.skills.map((s) => `\`${s}\``).join(", ") : "_none_"}`,
    `- Computer Use: ${t.computer_use ? "✓" : "✗"}`,
    "",
    "## Instructions",
    t.instructions_md,
    "",
    "## Acceptance criteria",
    "```",
    t.acceptance_criteria,
    "```",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/* ────────────────────────────────────────────────────────────
   Server factory
   ──────────────────────────────────────────────────────────── */

export interface CreateServerOpts {
  client?: PlyneHttpClient;
  logger?: (msg: string) => void;
}

export function createPlyneMcpServer(opts: CreateServerOpts = {}): Server {
  const log = opts.logger ?? ((m) => process.stderr.write(`[plyne-mcp] ${m}\n`));
  const client =
    opts.client ??
    (() => {
      const { token, source } = resolveAuthToken();
      const baseUrl = resolveBaseUrl();
      log(`auth=${source} baseUrl=${baseUrl}`);
      return new PlyneHttpClient({ baseUrl, token });
    })();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t })),
  }));

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs = {} } = req.params;
    try {
      switch (name) {
        case "plyne.task.create": {
          const input = TaskCreateInput.parse(rawArgs);
          const result = await client.createTask(input);
          return toolResult({ ok: true, ...result });
        }
        case "plyne.task.list": {
          const input = TaskListInput.parse(rawArgs);
          const rows = await client.listTasks(input);
          return toolResult({ ok: true, count: rows.length, items: rows });
        }
        case "plyne.task.get": {
          const { id } = TaskIdInput.parse(rawArgs);
          const t = await client.getTask(id);
          return toolResult({ ok: true, task: t });
        }
        case "plyne.task.logs": {
          const input = TaskLogsInput.parse(rawArgs);
          const out = await client.getLogs(input.id, {
            follow: input.follow,
            since: input.since,
            limit: input.limit,
          });
          return toolResult({ ok: true, ...out });
        }
        case "plyne.task.abort": {
          const input = TaskAbortInput.parse(rawArgs);
          const r = await client.abortTask(input.id, input.reason);
          return toolResult({ ok: r.ok });
        }
        default:
          return toolResult({ ok: false, error: `Unknown tool: ${name}` }, true);
      }
    } catch (err) {
      const msg =
        err instanceof ZodError
          ? `Invalid input: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
          : err instanceof Error
            ? err.message
            : String(err);
      log(`tool ${name} failed: ${msg}`);
      return toolResult({ ok: false, error: msg }, true);
    }
  });

  // resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }));

  // resources/templates/list
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  // resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === "plyne://my-quota") {
      const q = await client.quotaMe();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(q, null, 2),
          },
        ],
      };
    }
    if (uri === "plyne://team-activity") {
      const events = await client.activity(50);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(events, null, 2),
          },
        ],
      };
    }
    const taskMatch = uri.match(/^plyne:\/\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const t = await client.getTask(id);
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: renderTaskMarkdown(t),
          },
        ],
      };
    }
    throw new Error(`Unknown resource URI: ${uri}`);
  });

  return server;
}

function toolResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

/* ────────────────────────────────────────────────────────────
   Entry point — stdio (default) or streamable HTTP
   ──────────────────────────────────────────────────────────── */

async function main() {
  const transport = (process.env.PLYNE_MCP_TRANSPORT || "stdio").toLowerCase();
  const server = createPlyneMcpServer();

  if (transport === "stdio") {
    const t = new StdioServerTransport();
    await server.connect(t);
    process.stderr.write(`[plyne-mcp] connected via stdio (name=${SERVER_NAME} v${SERVER_VERSION})\n`);
    return;
  }

  if (transport === "http") {
    // Lazy import to keep stdio mode lightweight + avoid breaking when SDK <1.0 is installed.
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const { createServer } = await import("node:http");
    const port = Number(process.env.PORT || 8787);
    const path = process.env.PLYNE_MCP_PATH || "/mcp";

    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(t);

    const http = createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith(path)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        // Health endpoint
        if (req.url === `${path}/health`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
          return;
        }
        // Delegate to MCP transport
        await t.handleRequest(req, res);
      } catch (err) {
        process.stderr.write(
          `[plyne-mcp] http handler error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      }
    });
    http.listen(port, () => {
      process.stderr.write(
        `[plyne-mcp] listening http://localhost:${port}${path} (transport=streamable-http)\n`,
      );
    });
    return;
  }

  throw new Error(`Unknown PLYNE_MCP_TRANSPORT: ${transport}`);
}

// `tsx src/mcp/server.ts` direct invocation
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[plyne-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
