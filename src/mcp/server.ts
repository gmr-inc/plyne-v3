/**
 * Plyne v3 MCP server — REAL Anthropic MCP SDK implementation.
 *
 * Exposes 12 tools to external Claude Code sessions over Streamable HTTP:
 *
 *   Task lifecycle (5):
 *     - plyne.task.create / .list / .get / .logs / .abort
 *   Discovery / enrichment (7):
 *     - plyne.health
 *     - plyne.repos.list
 *     - plyne.skills.list / .describe
 *     - plyne.mcp_servers.list
 *     - plyne.products.list
 *     - plyne.task.template
 *
 * Transport: Streamable HTTP (no session id — stateless), per
 *   https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * Mounted by api/server.ts at `/mcp` (POST + GET supported).
 *
 * Author: Alberto, 2026-06-02.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import { loadEnv } from "../config/env.js";

// Lazy-load Notion-backed handlers so the MCP server can boot even when
// NOTION_TOKEN is missing — the discovery tools (health/repos/skills/...) still work,
// and the task.* tools fail at call-time with a clean error.
type NotionMod = typeof import("../notion/client.js");
let notionMod: NotionMod | null = null;
let notionLoadErr: string | null = null;
async function getNotion(): Promise<NotionMod> {
  if (notionMod) return notionMod;
  if (notionLoadErr) throw new Error(notionLoadErr);
  try {
    notionMod = await import("../notion/client.js");
    return notionMod;
  } catch (e) {
    notionLoadErr = `notion client unavailable: ${e instanceof Error ? e.message : String(e)}`;
    throw new Error(notionLoadErr);
  }
}

const SERVER_NAME = "plyne";
const SERVER_VERSION = "0.2.0";

const env = loadEnv();
const BOOT_TIME = Date.now();

// ──────────────────────────────────────────────────────────────────
// Static registries (repos / products / mcp servers / skill index)
// ──────────────────────────────────────────────────────────────────

interface RepoEntry {
  name: string;
  github_url: string;
  local_path: string;
  default_branch: string;
  layout: "root" | "monorepo_subfolder";
  subfolder?: string;
}

const REPOS: RepoEntry[] = [
  {
    name: "plyne-v3",
    github_url: "https://github.com/gmr-inc/plyne-v3",
    local_path: "/home/plyne/Desktop/Projects/plyne-v3",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "cto-v2",
    github_url: "https://github.com/gmr-inc/cto-v2",
    local_path: "/home/plyne/Desktop/Projects/cto-v2",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "marketear",
    github_url: "https://github.com/gmr-inc/marketear",
    local_path: "/home/plyne/Desktop/Projects/marketear",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "brynx",
    github_url: "https://github.com/gmr-inc/brynx",
    local_path: "/home/plyne/Desktop/Projects/brynx",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "crewrev-v2",
    github_url: "https://github.com/gmr-inc/crewrev-v2",
    local_path: "/home/plyne/Desktop/Projects/crewrev-v2",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "vetting-app",
    github_url: "https://github.com/gmr-inc/vetting-app",
    local_path: "/home/plyne/Desktop/Projects/vetting-app",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "geoky",
    github_url: "https://github.com/gmr-inc/geoky",
    local_path: "/home/plyne/Desktop/Projects/geoky",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "uxtwin",
    github_url: "https://github.com/gmr-inc/uxtwin",
    local_path: "/home/plyne/Desktop/Projects/uxtwin",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "dtwin-app",
    github_url: "https://github.com/gmr-inc/dtwin-app",
    local_path: "/home/plyne/Desktop/Projects/dtwin-app",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "dtwin-graph",
    github_url: "https://github.com/gmr-inc/dtwin-graph",
    local_path: "/home/plyne/Desktop/Projects/dtwin-graph",
    default_branch: "main",
    layout: "root"
  },
  {
    name: "twin-engine",
    github_url: "https://github.com/gmr-inc/twin-engine",
    local_path: "/home/plyne/Desktop/Projects/twin-engine",
    default_branch: "main",
    layout: "root"
  }
];

interface ProductEntry {
  code: string;
  full_name: string;
  repo: string;
  product_owner_email: string;
  product_owner_handle: string;
  tech_escalation: string;
}

const PRODUCTS: ProductEntry[] = [
  {
    code: "cto-v2",
    full_name: "Plyne (autonomous CTO orchestrator)",
    repo: "cto-v2",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "plyne-v3",
    full_name: "Plyne v3 (next-gen Claude Code orchestrator)",
    repo: "plyne-v3",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "marketear",
    full_name: "Marketear (ME) — marketing intelligence",
    repo: "marketear",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "brynx",
    full_name: "Brynx (BX) — listening + audience pulse",
    repo: "brynx",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "crewrev",
    full_name: "CrewRev (CR) — agentic monorepo",
    repo: "crewrev-v2",
    product_owner_email: "giuseppe@kpi6.com",
    product_owner_handle: "@Gyploforte",
    tech_escalation: "@jcte02"
  },
  {
    code: "influrep",
    full_name: "Influrep (IR) — influencer vetting",
    repo: "vetting-app",
    product_owner_email: "giuseppe@kpi6.com",
    product_owner_handle: "@Gyploforte",
    tech_escalation: "@jcte02"
  },
  {
    code: "klenux",
    full_name: "KLENUX / UXtwin (KX) — UX intelligence",
    repo: "uxtwin",
    product_owner_email: "gaetano@kpi6.com",
    product_owner_handle: "@gaetanomasi18",
    tech_escalation: "@jcte02"
  },
  {
    code: "geoky",
    full_name: "Geoky (GK) — conversational brand intelligence",
    repo: "geoky",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "dtwin",
    full_name: "dtwin (DT) — digital twin (paying customers)",
    repo: "dtwin-app",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  },
  {
    code: "dtwin-graph",
    full_name: "dtwin Graph (DT-GH) — twin engine API",
    repo: "dtwin-graph",
    product_owner_email: "alberto.nasciuti@kpi6.com",
    product_owner_handle: "@albertonasciuti",
    tech_escalation: "@jcte02"
  }
];

interface McpServerEntry {
  name: string;
  description: string;
  required_env_vars: string[];
}

const MCP_SERVERS: McpServerEntry[] = [
  {
    name: "github",
    description: "Anthropic official GitHub MCP — issues, PRs, repos, files",
    required_env_vars: ["GITHUB_TOKEN", "GH_TOKEN"]
  },
  {
    name: "notion",
    description: "Notion MCP — databases, pages, comments (used for Tasks v2)",
    required_env_vars: ["NOTION_TOKEN"]
  },
  {
    name: "vercel",
    description: "Vercel MCP — deployments, env vars, projects, domains",
    required_env_vars: ["VERCEL_TOKEN"]
  },
  {
    name: "supabase",
    description: "Supabase MCP — projects, SQL, edge functions, migrations",
    required_env_vars: ["SUPABASE_ACCESS_TOKEN"]
  },
  {
    name: "slack",
    description: "Slack MCP — channels, messages, threads",
    required_env_vars: ["SLACK_BOT_TOKEN"]
  }
];

// AC templates indexed by effort + simple product-bucket heuristic
const AC_TEMPLATES: Record<string, string> = {
  XS: `## Acceptance Criteria
- [ ] Single-file change applied, no behaviour regressions
- [ ] Manual smoke: relevant page/command still works
- [ ] Commit conventional: <type>(<scope>): <subject> (TASK-ID)`,

  S: `## Acceptance Criteria
- [ ] Implementation complete in <=2 files
- [ ] At least 1 unit test added/updated
- [ ] CI green (lint + typecheck + test)
- [ ] PR opened with Summary + Test plan sections
- [ ] Conventional commit + TASK-ID trailer`,

  M: `## Acceptance Criteria
- [ ] Feature implemented per Instructions section
- [ ] Unit tests cover happy path + 1 error path
- [ ] Integration test or E2E smoke for new endpoint/component
- [ ] CI green (lint + typecheck + test + build)
- [ ] Vercel preview deploy green (if web product)
- [ ] CodeRabbit review with no HIGH severity unresolved
- [ ] Manual visual verification (screenshot in PR body for UI changes)
- [ ] Conventional commit + TASK-ID trailer`,

  L: `## Acceptance Criteria
- [ ] Architecture follows the Instructions section
- [ ] All affected modules covered by tests (>=70% lines on new code)
- [ ] Migration script + rollback path documented (if DB)
- [ ] Feature flag default OFF, opt-in via env (if behaviour-changing)
- [ ] Sentry monitoring wired for new error paths
- [ ] Vercel preview deploy reviewed by Alberto OR Luna (if dtwin)
- [ ] CodeRabbit review HIGH=0, MEDIUM <=2 with explicit rationale
- [ ] Visual evidence pipeline for UI: Playwright + Claude Vision verdict + public URL
- [ ] Conventional commit + TASK-ID trailer + Co-Authored-By`,

  XL: `## Acceptance Criteria
- [ ] Spec doc shipped under docs/<feature>/ before code
- [ ] Implementation split into >=3 mergeable PRs with Blocked-by chain
- [ ] First PR is scaffold-only (no behavior change)
- [ ] Each PR independently CI-green + reviewed
- [ ] Migration scripts versioned + rehearsed on staging
- [ ] Sentry + observability dashboards updated
- [ ] User-facing docs updated (if customer-visible)
- [ ] Rollback runbook in docs/runbooks/
- [ ] Manual end-to-end test by Alberto before merge of final PR
- [ ] Conventional commits + TASK-ID trailers throughout`
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Find repo root by walking up from src/mcp/server.ts (dist/mcp/server.js at runtime). */
function findRepoRoot(): string {
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, "package.json"))) return cur;
    cur = path.dirname(cur);
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();
const SKILLS_DIR = path.join(REPO_ROOT, "skills");

function listSkillsOnDisk(): Array<{
  name: string;
  description: string;
  usage_summary: string;
  mcp_dependencies: string[];
}> {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: Array<{
    name: string;
    description: string;
    usage_summary: string;
    mcp_dependencies: string[];
  }> = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const raw = fs.readFileSync(skillFile, "utf8");
    out.push({
      name: entry.name,
      description: extractFrontmatterScalar(raw, "description") ?? "",
      usage_summary: extractFrontmatterScalar(raw, "usage") ?? "",
      mcp_dependencies: extractFrontmatterArray(raw, "mcp_dependencies")
    });
  }
  return out;
}

/** Tiny YAML-frontmatter extractor — supports `key: scalar` and `key: |` block scalar. */
function extractFrontmatterScalar(raw: string, key: string): string | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const flat = line.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`));
    if (flat && !flat[1]?.startsWith("|") && !flat[1]?.startsWith(">")) {
      return flat[1] ?? null;
    }
    const block = line.match(new RegExp(`^${key}:\\s*[|>]\\s*$`));
    if (block) {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.match(/^\S/)) break;
        collected.push(next.replace(/^\s\s/, ""));
      }
      return collected.join(" ").trim();
    }
  }
  return null;
}

function extractFrontmatterArray(raw: string, key: string): string[] {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  const fm = m[1] ?? "";
  const inline = fm.match(new RegExp(`^${key}:\\s*\\[(.+?)\\]\\s*$`, "m"));
  if (inline) {
    return (inline[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

function detectMcpStatus(srv: McpServerEntry): "available" | "unavailable" {
  for (const v of srv.required_env_vars) {
    if (process.env[v]) return "available";
  }
  return "unavailable";
}

// ──────────────────────────────────────────────────────────────────
// MCP server factory
// ──────────────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ── plyne.health ──────────────────────────────────────────────
  server.registerTool(
    "plyne.health",
    {
      title: "Plyne health",
      description: "Liveness + capacity snapshot of the Plyne v3 orchestrator daemon.",
      inputSchema: {}
    },
    async () => {
      const uptime_seconds = Math.floor((Date.now() - BOOT_TIME) / 1000);
      const body = {
        uptime_seconds,
        queue_depth: null as number | null,
        in_flight_tasks: [] as string[],
        version: SERVER_VERSION,
        model_default: env.PLYNE_CLAUDE_MODEL,
        extended_thinking_default: env.PLYNE_EXTENDED_THINKING,
        max_concurrent_tasks: env.MAX_CONCURRENT_TASKS,
        task_prefix_filter: env.PLYNE_V3_TASK_PREFIX,
        total_tasks_done_24h: null as number | null,
        note: "queue_depth + in_flight + done_24h require runner instrumentation (TODO)"
      };
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    }
  );

  // ── plyne.repos.list ──────────────────────────────────────────
  server.registerTool(
    "plyne.repos.list",
    {
      title: "List repos",
      description: "Repo allowlist with paths + layout (root vs monorepo_subfolder).",
      inputSchema: {}
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ repos: REPOS }, null, 2) }]
    })
  );

  // ── plyne.skills.list ─────────────────────────────────────────
  server.registerTool(
    "plyne.skills.list",
    {
      title: "List skills",
      description: "Scan skills/ dir and return each SKILL.md frontmatter summary.",
      inputSchema: {}
    },
    async () => {
      const skills = listSkillsOnDisk();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ skills, dir: SKILLS_DIR }, null, 2)
          }
        ]
      };
    }
  );

  // ── plyne.skills.describe ─────────────────────────────────────
  server.registerTool(
    "plyne.skills.describe",
    {
      title: "Describe skill",
      description: "Return the full SKILL.md body for the named skill.",
      inputSchema: { skill_name: z.string().min(1) }
    },
    async ({ skill_name }: { skill_name: string }) => {
      const safe = skill_name.replace(/[^a-zA-Z0-9_-]/g, "");
      const file = path.join(SKILLS_DIR, safe, "SKILL.md");
      if (!fs.existsSync(file)) {
        return {
          isError: true,
          content: [{ type: "text", text: `skill not found: ${skill_name}` }]
        };
      }
      const body = fs.readFileSync(file, "utf8");
      return { content: [{ type: "text", text: body }] };
    }
  );

  // ── plyne.mcp_servers.list ────────────────────────────────────
  server.registerTool(
    "plyne.mcp_servers.list",
    {
      title: "List MCP servers",
      description:
        "External MCP servers Plyne tasks can attach to (with availability based on env vars).",
      inputSchema: {}
    },
    async () => {
      const servers = MCP_SERVERS.map((s) => ({
        ...s,
        status: detectMcpStatus(s)
      }));
      return { content: [{ type: "text", text: JSON.stringify({ servers }, null, 2) }] };
    }
  );

  // ── plyne.products.list ───────────────────────────────────────
  server.registerTool(
    "plyne.products.list",
    {
      title: "List products",
      description:
        "GMR product registry with PO mapping (PO + tech escalation), repo, recent activity (TODO).",
      inputSchema: {}
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              products: PRODUCTS,
              recent_pr_per_product:
                "TODO: wire GitHub MCP fetch — currently stub. Use github MCP tools directly for now."
            },
            null,
            2
          )
        }
      ]
    })
  );

  // ── plyne.task.template ───────────────────────────────────────
  server.registerTool(
    "plyne.task.template",
    {
      title: "Task AC template",
      description:
        "Suggested Acceptance Criteria template for a given effort (XS|S|M|L|XL) + product hint.",
      inputSchema: {
        effort: z.enum(["XS", "S", "M", "L", "XL"]),
        product: z.string().optional()
      }
    },
    async (args: { effort: "XS" | "S" | "M" | "L" | "XL"; product?: string | undefined }) => {
      const { effort, product } = args;
      const base = AC_TEMPLATES[effort] ?? "";
      const productHint = product
        ? `\n\n## Product hint\nProduct: ${product}\nLook up product owner + repo via \`plyne.products.list\`.`
        : "";
      return {
        content: [{ type: "text", text: base + productHint }]
      };
    }
  );

  // ── plyne.task.list ───────────────────────────────────────────
  server.registerTool(
    "plyne.task.list",
    {
      title: "List ready tasks",
      description: "List ready tasks matching the V3 prefix filter (default PLYNE_V3_TASK_PREFIX).",
      inputSchema: {
        prefix: z.string().optional(),
        limit: z.number().int().positive().max(50).optional()
      }
    },
    async (args: { prefix?: string | undefined; limit?: number | undefined }) => {
      const { prefix, limit } = args;
      const n = await getNotion();
      const tasks = await n.listReadyTasks(prefix ?? env.PLYNE_V3_TASK_PREFIX, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify({ tasks }, null, 2) }] };
    }
  );

  // ── plyne.task.get ────────────────────────────────────────────
  server.registerTool(
    "plyne.task.get",
    {
      title: "Get task",
      description: "Fetch one task by Notion page id.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }: { id: string }) => {
      const n = await getNotion();
      const task = await n.getTask(id);
      if (!task) {
        return {
          isError: true,
          content: [{ type: "text", text: `task not found: ${id}` }]
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }
  );

  // ── plyne.task.create ─────────────────────────────────────────
  server.registerTool(
    "plyne.task.create",
    {
      title: "Create task",
      description:
        "Placeholder — direct task creation flows through Notion MCP today; v3 ingest pending.",
      inputSchema: {
        title: z.string().min(1).optional(),
        product: z.string().optional(),
        instructions_md: z.string().optional(),
        acceptance_criteria: z.string().optional()
      }
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              reason: "creation handled via notion MCP; v3 native create pending implementation"
            },
            null,
            2
          )
        }
      ]
    })
  );

  // ── plyne.task.logs ───────────────────────────────────────────
  server.registerTool(
    "plyne.task.logs",
    {
      title: "Task logs",
      description: "Placeholder — log streaming pending Supabase migration.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }: { id: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, taskId: id, reason: "log streaming pending" }, null, 2)
        }
      ]
    })
  );

  // ── plyne.task.abort ──────────────────────────────────────────
  server.registerTool(
    "plyne.task.abort",
    {
      title: "Abort task",
      description: "Flip a task to needs-operator and post an abort comment.",
      inputSchema: {
        id: z.string().min(1),
        reason: z.string().optional()
      }
    },
    async (args: { id: string; reason?: string | undefined }) => {
      const { id, reason } = args;
      const n = await getNotion();
      await n.setStatus(id, "needs-operator");
      await n.addComment(id, `Plyne v3 task aborted via MCP: ${reason ?? "aborted via MCP"}`);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
    }
  );

  return server;
}

// ──────────────────────────────────────────────────────────────────
// HTTP handlers (mounted by api/server.ts at `/mcp`)
// ──────────────────────────────────────────────────────────────────

/**
 * Handle MCP requests over Streamable HTTP.
 *
 * Stateless mode: create one McpServer + transport per request, then dispose.
 * (For sub-100 RPS this is fine and avoids cross-request leakage.)
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  // Friendly GET — return capabilities summary so curl-from-anywhere works.
  if (req.method === "GET") {
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      tools: [
        "plyne.health",
        "plyne.repos.list",
        "plyne.skills.list",
        "plyne.skills.describe",
        "plyne.mcp_servers.list",
        "plyne.products.list",
        "plyne.task.template",
        "plyne.task.list",
        "plyne.task.get",
        "plyne.task.create",
        "plyne.task.logs",
        "plyne.task.abort"
      ],
      docs: "POST JSON-RPC 2.0 requests per MCP spec 2025-06-18"
    });
    return;
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    const server = buildMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true
    } as any);

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await server.connect(transport as any);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "mcp: request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error", data: String(err) },
        id: null
      });
    }
  }
}
