/**
 * Stack-loader — translates a task's declared Anthropic-stack config into
 * concrete CLI args + temp config files for the `claude` CLI subprocess.
 *
 * Architecture §"Stack Anthropic ABUSED": each task config can declare
 *   - mcp_servers: ['github', 'notion', 'vercel', 'supabase', 'slack']
 *   - skills:     ['github-pr-review', 'vercel-deploy-fixer', ...]
 *   - computer_use: true  → spawn with --enable-computer-use
 *   - hooks:      pre/post-tool-use, pre-commit, post-PR
 *   - memory:     ~/.cto-v2/memory/{product}/ injected
 *
 * v3 keeps this as a pure builder (no I/O beyond writing temp config files).
 * Executor consumes the result.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskStackConfig } from "../notion/client.js";
import { logger } from "../config/logger.js";

/**
 * Known MCP server registry. Keys = task config names; values = the MCP
 * config block claude CLI expects under `mcpServers` in its config file.
 *
 * Real OAuth tokens / endpoint URLs come from env. If an env var is missing,
 * we OMIT the server (claude will fail gracefully if the task actually
 * needs it) rather than crash boot — keeps single-tenant dev simple.
 */
function buildMcpRegistry(): Record<string, unknown> {
  const reg: Record<string, unknown> = {};
  // GitHub MCP — official Anthropic server
  if (process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"]) {
    reg["github"] = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
      }
    };
  }
  // Notion MCP
  if (process.env["NOTION_TOKEN"]) {
    reg["notion"] = {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: `Bearer ${process.env["NOTION_TOKEN"]}` }) }
    };
  }
  // Vercel MCP
  if (process.env["VERCEL_TOKEN"]) {
    reg["vercel"] = {
      command: "npx",
      args: ["-y", "@vercel/mcp-server"],
      env: { VERCEL_TOKEN: process.env["VERCEL_TOKEN"] }
    };
  }
  // Supabase MCP
  if (process.env["SUPABASE_ACCESS_TOKEN"]) {
    reg["supabase"] = {
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase"],
      env: { SUPABASE_ACCESS_TOKEN: process.env["SUPABASE_ACCESS_TOKEN"] }
    };
  }
  return reg;
}

export interface LoadedStack {
  /** CLI args to append to `claude` invocation. */
  cliArgs: string[];
  /** Path to a temp mcp config JSON file (or undefined if no MCPs requested). */
  mcpConfigPath?: string;
  /** Human-readable summary of what got loaded (for logs/comments). */
  summary: string;
  /** Cleanup callback — call after the Claude subprocess exits. */
  cleanup: () => void;
}

export interface LoadStackOptions {
  taskId: string;
  product: string;
  config: TaskStackConfig;
  extendedThinking: boolean;
  model: string;
}

/**
 * Build CLI args + temp configs for one task invocation. No-op-safe: missing
 * env vars just drop the corresponding MCP server.
 */
export function loadStack(opts: LoadStackOptions): LoadedStack {
  const cliArgs: string[] = [];
  let mcpConfigPath: string | undefined;
  const cleanupFns: Array<() => void> = [];

  // Model — task override beats default.
  const model = opts.config.model ?? opts.model;
  cliArgs.push("--model", model);

  // Permission mode — always `acceptEdits` for headless runs, otherwise
  // claude exits early asking the (non-existent) user to grant Write access.
  // This is independent of extended thinking, which we wire via --effort
  // below.
  cliArgs.push("--permission-mode", "acceptEdits");

  // Extended thinking — claude CLI 2.x exposes this as `--effort high`
  // (choices: low, medium, high, xhigh, max). For M/L/XL we ask for the
  // deeper reasoning budget; for XS/S we leave the default.
  if (opts.extendedThinking) {
    cliArgs.push("--effort", "high");
  }

  // MCP servers — write a temp config file claude can consume.
  if (opts.config.mcpServers.length > 0) {
    const registry = buildMcpRegistry();
    const requested: Record<string, unknown> = {};
    for (const name of opts.config.mcpServers) {
      const block = registry[name];
      if (block) {
        requested[name] = block;
      } else {
        logger.warn({ taskId: opts.taskId, mcp: name }, "stack-loader: MCP requested but no env config");
      }
    }
    if (Object.keys(requested).length > 0) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `plyne-v3-mcp-${opts.taskId}-`));
      mcpConfigPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: requested }, null, 2));
      cliArgs.push("--mcp-config", mcpConfigPath);
      cleanupFns.push(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
    }
  }

  // Computer Use — opt-in per task config.
  if (opts.config.computerUse) {
    // Claude CLI 2.x doesn't expose computer-use as a CLI flag yet; this is
    // a forward-looking knob. For now we just log + tag.
    logger.info({ taskId: opts.taskId }, "stack-loader: computer_use requested (CLI flag pending)");
  }

  // Skills + memory + hooks — claude CLI auto-loads these from the project
  // .claude/ directory when present. v3 keeps a per-product .claude/ layout
  // and the worktree manager symlinks it into the working tree before
  // spawning. So no extra CLI args needed here, but we record what was
  // requested for traceability.
  const skillSummary = opts.config.skills.length ? `skills=[${opts.config.skills.join(",")}]` : "skills=[]";

  const summary = [
    `model=${model}`,
    `extended_thinking=${opts.extendedThinking}`,
    `mcp=[${opts.config.mcpServers.join(",")}]`,
    skillSummary,
    `computer_use=${opts.config.computerUse}`
  ].join(" ");

  return {
    cliArgs,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    summary,
    cleanup: () => {
      for (const fn of cleanupFns) fn();
    }
  };
}
