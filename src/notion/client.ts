/**
 * Minimal Notion gateway for Plyne v3.
 *
 * v2 had a 2000-line gateway covering 11 lifecycle phases, spec ingest
 * rejection paths, brain enrichment, healing comments. v3 needs four ops:
 *   1. List ready tasks (filtered by status + V3 prefix)
 *   2. Read one task (full properties + comments)
 *   3. Update status (with optional comment + pr_url)
 *   4. Append a comment (free-form, for progress trace)
 */
import { Client } from "@notionhq/client";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { mirrorTaskStatus } from "../lib/supabase-reporter.js";

const env = loadEnv();
const notion = new Client({ auth: env.NOTION_TOKEN });

/**
 * Live boot-time check: ping `users.me` to confirm the NOTION_TOKEN is not
 * just non-empty (already enforced by Zod) but actually valid.
 *
 * Why: on 2026-06-02 the v3 daemon piled up 1923 pm2 restarts in 2h because
 * the env was syntactically valid but the token had been rotated. The
 * `@notionhq/client` library only logs `request fail` warnings on 401; the
 * runner caught the cycle error and kept polling, burning Notion API quota
 * and log volume. Failing fast at boot makes pm2's restart-count surface the
 * problem within seconds, instead of letting it bleed.
 */
export async function verifyNotionTokenLive(): Promise<void> {
  try {
    await notion.users.me({});
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    // eslint-disable-next-line no-console
    console.error(
      `FATAL: NOTION_TOKEN failed live verification (code=${e.code ?? "?"} ` +
        `status=${e.status ?? "?"}): ${e.message ?? String(err)}`
    );
    process.exit(1);
  }
}

/**
 * True when the error looks like a Notion auth failure (token revoked, scope
 * dropped, etc). Used by the runner to break out of the polling loop instead
 * of spamming 401s every 15s forever.
 */
export function isNotionAuthError(err: unknown): boolean {
  const e = err as { code?: string; status?: number };
  return e?.code === "unauthorized" || e?.status === 401;
}

export const TaskStatus = z.enum([
  "backlog",
  "draft",
  "ready",
  "claiming",
  "executing",
  "pr-open",
  "done",
  "needs-operator",
  "abandoned",
  "cancelled"
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Per-task Anthropic-stack config — read from task properties.
 * Architecture §"Data model": mcp_servers, skills, computer_use, model.
 */
export interface TaskStackConfig {
  mcpServers: string[];
  skills: string[];
  computerUse: boolean;
  model?: string | undefined;
}

export interface Task {
  id: string; // Notion page id
  externalId: string; // e.g. "V3-TEST-HELLO-001"
  title: string;
  status: TaskStatus;
  product: string;
  repo: string;
  effort: "XS" | "S" | "M" | "L" | "XL" | null;
  instructions: string;
  acceptanceCriteria: string;
  stack: TaskStackConfig;
  prUrl: string | null;
}

function getTitle(props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (props as any)?.["Name"] ?? (props as any)?.["Title"];
  if (!t?.title?.length) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t.title.map((s: any) => s?.plain_text ?? "").join("");
}

function getRichText(props: Record<string, unknown>, key: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (props as any)?.[key];
  if (!p?.rich_text?.length) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return p.rich_text.map((s: any) => s?.plain_text ?? "").join("");
}

function getSelect(props: Record<string, unknown>, key: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props as any)?.[key]?.select?.name ?? null;
}

function getStatus(props: Record<string, unknown>, key = "Status"): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props as any)?.[key]?.status?.name ?? null;
}

function getMultiSelect(props: Record<string, unknown>, key: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ms = (props as any)?.[key]?.multi_select;
  if (!Array.isArray(ms)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ms.map((o: any) => o?.name).filter(Boolean);
}

function getCheckbox(props: Record<string, unknown>, key: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props as any)?.[key]?.checkbox === true;
}

function getUrl(props: Record<string, unknown>, key: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props as any)?.[key]?.url ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPage(page: any): Task | null {
  const props = page?.properties ?? {};
  const externalId = getTitle(props);
  const statusRaw = getStatus(props) ?? getSelect(props, "Status");
  const parsedStatus = TaskStatus.safeParse(statusRaw);
  if (!parsedStatus.success) return null;
  const effortRaw = getSelect(props, "Effort");
  const effort =
    effortRaw === "XS" || effortRaw === "S" || effortRaw === "M" || effortRaw === "L" || effortRaw === "XL"
      ? effortRaw
      : null;
  return {
    id: page.id,
    externalId,
    title: getRichText(props, "Description") || externalId,
    status: parsedStatus.data,
    product: getSelect(props, "Product") ?? "",
    repo: getSelect(props, "Repo") ?? "",
    effort,
    instructions: getRichText(props, "Instructions"),
    acceptanceCriteria: getRichText(props, "Acceptance Criteria"),
    stack: {
      mcpServers: getMultiSelect(props, "MCP Servers"),
      skills: getMultiSelect(props, "Skills"),
      computerUse: getCheckbox(props, "Computer Use"),
      model: getSelect(props, "Model") ?? undefined
    },
    prUrl: getUrl(props, "PR URL")
  };
}

/**
 * List tasks in `ready` status filtered to the V3 prefix.
 * Returns at most `limit` rows ordered by oldest-first (FIFO).
 */
export async function listReadyTasks(prefix: string, limit = 5): Promise<Task[]> {
  const res = await notion.databases.query({
    database_id: env.NOTION_TASKS_DB_ID,
    page_size: 25,
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  });
  const tasks: Task[] = [];
  for (const page of res.results) {
    const t = mapPage(page);
    if (!t) continue;
    if (t.status !== "ready") continue;
    if (prefix && !t.externalId.startsWith(prefix)) continue;
    tasks.push(t);
    if (tasks.length >= limit) break;
  }
  return tasks;
}

/**
 * List tasks in an arbitrary status filtered to the V3 prefix.
 *
 * Sibling of listReadyTasks (which is intentionally left untouched per the
 * task contract). The auto-merge loop uses this to find `pr-open` tasks. Same
 * FIFO ordering + prefix isolation so v3 never touches v2's PRs.
 */
export async function listTasksByStatus(
  status: TaskStatus,
  prefix: string,
  limit = 25
): Promise<Task[]> {
  const res = await notion.databases.query({
    database_id: env.NOTION_TASKS_DB_ID,
    page_size: 50,
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  });
  const tasks: Task[] = [];
  for (const page of res.results) {
    const t = mapPage(page);
    if (!t) continue;
    if (t.status !== status) continue;
    if (prefix && !t.externalId.startsWith(prefix)) continue;
    tasks.push(t);
    if (tasks.length >= limit) break;
  }
  return tasks;
}

export async function getTask(pageId: string): Promise<Task | null> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return mapPage(page);
  } catch (err) {
    logger.warn({ pageId, err }, "notion.getTask failed");
    return null;
  }
}

/**
 * Promote an ingestion-created task: flip Status → `ready` AND rewrite the
 * Name (external_id) to a runner-visible prefix so listReadyTasks() claims it.
 * Both writes happen in a single Notion update so the task never sits in an
 * inconsistent half-promoted state.
 *
 * Used exclusively by the auto-promote policy (src/ingestion/auto-promote.ts).
 * The status mirror to plyne-app Supabase runs the same as setStatus().
 */
export async function promoteToReady(pageId: string, newExternalId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "ready" } },
      Name: { title: [{ type: "text", text: { content: newExternalId.slice(0, 60) } }] }
    }
  });
  await mirrorTaskStatus(pageId, "ready");
}

/**
 * Count tasks awaiting operator attention — used by the auto-promote circuit
 * breaker so we don't pile autonomous work on a queue the human is already
 * behind on. Counts `needs-operator` + `ready` across the given prefixes
 * (empty = all). Best-effort caller handles the throw (fail-closed).
 */
export async function countOpenOperatorBacklog(prefixes: string[]): Promise<number> {
  const res = await notion.databases.query({
    database_id: env.NOTION_TASKS_DB_ID,
    page_size: 100,
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });
  let n = 0;
  for (const page of res.results) {
    const t = mapPage(page);
    if (!t) continue;
    if (t.status !== "needs-operator" && t.status !== "ready") continue;
    if (prefixes.length > 0 && !prefixes.some((p) => t.externalId.startsWith(p))) continue;
    n += 1;
  }
  return n;
}

export async function setStatus(pageId: string, status: TaskStatus, prUrl?: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {
    Status: { status: { name: status } }
  };
  if (prUrl) properties["PR URL"] = { url: prUrl };
  await notion.pages.update({ page_id: pageId, properties });

  // LIVE mirror to plyne-app Supabase so the FE reflects daemon progress in
  // real time (pipeline/tabs/PR). Best-effort: no-ops when PLYNE_APP_SUPABASE_*
  // is unset, and swallows all its own errors — must never break the Notion
  // write or the runner. Awaited so the row lands promptly, but a slow/failed
  // Supabase can't throw here (mirrorTaskStatus never rejects).
  await mirrorTaskStatus(pageId, status, prUrl);
}

export async function addComment(pageId: string, text: string): Promise<void> {
  // Notion comment body has a 2000-char limit per rich-text segment; chunk if needed.
  const MAX = 1900;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  await notion.comments.create({
    parent: { page_id: pageId },
    rich_text: chunks.map((c) => ({ type: "text" as const, text: { content: c } }))
  });
}
