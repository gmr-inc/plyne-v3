/**
 * PlyneHttpClient — typed REST client for the Plyne v3 backend.
 *
 * Wires the 5 MCP tools + 3 resources to the internal REST API exposed by
 * `src/api/server.ts` in the parallel backend scaffold.
 *
 * Auth: bearer JWT (OAuth) OR personal access token (`PLYNE_PAT` env var).
 *
 * Spec: tech-spec-frontend.md §3 + plyne-v3-architecture.md §Stack-Anthropic.
 */
import { z } from "zod";

/* ────────────────────────────────────────────────────────────
   Zod schemas — public contract for tool inputs/outputs
   ──────────────────────────────────────────────────────────── */

export const TaskCreateInput = z.object({
  title: z.string().min(3),
  product: z.string().min(2),
  repo: z.string().optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional().default("P2"),
  effort: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
  instructions_md: z.string().min(20),
  acceptance_criteria: z.string().min(10),
  po_id: z.string().optional(),
  // Anthropic stack config (NEW in v3)
  mcp_servers: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
  computer_use: z.boolean().optional().default(false),
  model: z
    .enum(["claude-opus-4-8", "claude-sonnet-4-6", "latest"])
    .optional()
    .default("claude-opus-4-8"),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInput>;

export const TaskListInput = z.object({
  status: z.string().optional(),
  owner: z.string().optional(),
  product: z.string().optional(),
  repo: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});
export type TaskListInput = z.infer<typeof TaskListInput>;

export const TaskIdInput = z.object({ id: z.string().min(1) });
export type TaskIdInput = z.infer<typeof TaskIdInput>;

export const TaskAbortInput = z.object({
  id: z.string().min(1),
  reason: z.string().optional(),
});
export type TaskAbortInput = z.infer<typeof TaskAbortInput>;

export const TaskLogsInput = z.object({
  id: z.string().min(1),
  follow: z.boolean().optional().default(false),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(2000).optional().default(200),
});
export type TaskLogsInput = z.infer<typeof TaskLogsInput>;

export interface PlyneClient {
  createTask(input: TaskCreateInput): Promise<{ id: string; url: string; status: string }>;
  listTasks(
    input: TaskListInput,
  ): Promise<Array<{ id: string; title: string; status: string; product: string; pr_url?: string }>>;
  getTask(id: string): Promise<{
    id: string;
    title: string;
    status: string;
    product: string;
    repo: string;
    instructions_md: string;
    acceptance_criteria: string;
    pr_url?: string;
    mcp_servers: string[];
    skills: string[];
    computer_use: boolean;
    model: string;
    cost_usd: number;
    attempts: number;
  }>;
  abortTask(id: string, reason?: string): Promise<{ ok: boolean }>;
  getLogs(
    id: string,
    opts: { follow?: boolean; since?: string; limit?: number },
  ): Promise<{ lines: Array<{ t: string; lvl: string; msg: string }>; cursor?: string }>;
  quotaMe(): Promise<{
    user: string;
    session: number;
    week: number;
    plan: string;
    per_model?: Record<string, number>;
  }>;
  activity(
    limit: number,
  ): Promise<
    Array<{ user: string; verb: string; target: string; product: string; kind: string; t: string }>
  >;
}

/* ────────────────────────────────────────────────────────────
   HTTP impl
   ──────────────────────────────────────────────────────────── */

export interface PlyneHttpClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class PlyneHttpClient implements PlyneClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: PlyneHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("PlyneHttpClient: no fetch implementation available (Node <18?)");
    }
  }

  private async req<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "plyne-mcp/0.1.0",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plyne API ${res.status} ${method} ${path}: ${text.slice(0, 400)}`);
    }
    // Tolerate 204
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createTask(input: TaskCreateInput) {
    const parsed = TaskCreateInput.parse(input);
    return this.req<{ id: string; url: string; status: string }>("POST", "/v1/tasks", parsed);
  }

  listTasks(input: TaskListInput) {
    const parsed = TaskListInput.parse(input);
    return this.req<Array<{ id: string; title: string; status: string; product: string; pr_url?: string }>>(
      "GET",
      "/v1/tasks",
      undefined,
      parsed as Record<string, string | number>,
    );
  }

  getTask(id: string) {
    return this.req<Awaited<ReturnType<PlyneClient["getTask"]>>>("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  }

  abortTask(id: string, reason?: string) {
    return this.req<{ ok: boolean }>("DELETE", `/v1/tasks/${encodeURIComponent(id)}`, { reason });
  }

  getLogs(id: string, opts: { follow?: boolean; since?: string; limit?: number }) {
    return this.req<{ lines: Array<{ t: string; lvl: string; msg: string }>; cursor?: string }>(
      "GET",
      `/v1/tasks/${encodeURIComponent(id)}/logs`,
      undefined,
      { since: opts.since, limit: opts.limit, follow: opts.follow },
    );
  }

  quotaMe() {
    return this.req<Awaited<ReturnType<PlyneClient["quotaMe"]>>>("GET", "/v1/me/quota");
  }

  activity(limit: number) {
    return this.req<Awaited<ReturnType<PlyneClient["activity"]>>>(
      "GET",
      "/v1/activity",
      undefined,
      { limit },
    );
  }
}

/* ────────────────────────────────────────────────────────────
   Auth resolution — OAuth JWT from token store OR PAT from env
   ──────────────────────────────────────────────────────────── */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveAuthToken(): { token: string; source: "pat" | "oauth-store" } {
  const pat = process.env.PLYNE_PAT?.trim();
  if (pat) return { token: pat, source: "pat" };

  const storePath = join(homedir(), ".claude", "mcp-credentials", "plyne.json");
  if (existsSync(storePath)) {
    try {
      const raw = JSON.parse(readFileSync(storePath, "utf8")) as { access_token?: string };
      if (raw.access_token) return { token: raw.access_token, source: "oauth-store" };
    } catch {
      /* fall-through */
    }
  }
  throw new Error(
    "Plyne MCP: no auth token. Set PLYNE_PAT env var OR run `plyne-cli auth login` to populate ~/.claude/mcp-credentials/plyne.json",
  );
}

export function resolveBaseUrl(): string {
  return (
    process.env.PLYNE_API_URL?.trim() ||
    process.env.PLYNE_BASE_URL?.trim() ||
    "https://plyne.dev"
  );
}
