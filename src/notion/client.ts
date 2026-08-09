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
 * Indirection over `notion.pages.update` so the defensive `setStatus` fallback
 * can be unit-tested without a live Notion workspace. Production points at the
 * real client; `__test.injectPagesUpdate` swaps in a stub.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PagesUpdateFn = (args: any) => Promise<any>;
let _pagesUpdate: PagesUpdateFn = (args) => notion.pages.update(args);

// Read calls are safe to repeat. Notion occasionally answers with a gateway
// 520, a client timeout, or a reset socket; treating the first transient as a
// product bug creates three Sentry issues for the same short network wobble.
// Keep writes single-shot: retrying a write after a lost response can duplicate
// an action.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabasesQueryFn = (args: any) => Promise<any>;
let _databasesQuery: DatabasesQueryFn = (args) => notion.databases.query(args);
let _retrySleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const NOTION_READ_MAX_ATTEMPTS = 3;
const NOTION_READ_RETRY_DELAYS_MS = [250, 750];

export function isTransientNotionReadError(err: unknown): boolean {
  const e = err as { code?: string; status?: number; name?: string; message?: string };
  if (typeof e?.status === "number" && e.status >= 500 && e.status <= 599) return true;
  const code = String(e?.code ?? "").toUpperCase();
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "NOTIONHQ_CLIENT_REQUEST_TIMEOUT"
    ].includes(code)
  ) {
    return true;
  }
  if (e?.name === "RequestTimeoutError") return true;
  const message = String(e?.message ?? "").toLowerCase();
  return (
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("request timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed")
  );
}

async function queryDatabaseWithTransientRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let attempt = 1; attempt <= NOTION_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await _databasesQuery(args);
    } catch (err) {
      if (!isTransientNotionReadError(err) || attempt === NOTION_READ_MAX_ATTEMPTS) {
        throw err;
      }
      logger.warn(
        { attempt, maxAttempts: NOTION_READ_MAX_ATTEMPTS, err },
        "notion database read failed transiently — retrying"
      );
      await _retrySleep(NOTION_READ_RETRY_DELAYS_MS[attempt - 1] ?? 750);
    }
  }
  throw new Error("unreachable notion read retry state");
}

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
  "needs-rework",
  "needs-revision",
  "abandoned",
  "cancelled"
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * The Notion rich-text property where the runner writes the human-oriented
 * escalation reason (so the console's LLM layer can explain WHY a human is
 * needed). Kept as a constant so the defensive `setStatus` path can strip it
 * by name if the board doesn't have the property yet.
 */
export const CTO_FEEDBACK_PROP = "CTO Feedback";

/**
 * Ordered fallback chain for escalation statuses. If a target `setStatus`
 * option is MISSING on the Notion board (the 2026-06 `needs-operator`
 * status-missing bug that stranded tasks), we walk this chain rather than
 * throwing — a missing status must never again strand a task. The reason is
 * still written regardless of which status finally sticks.
 */
const ESCALATION_FALLBACK: Record<string, TaskStatus[]> = {
  "needs-revision": ["needs-revision", "needs-rework", "needs-operator"],
  "needs-rework": ["needs-rework", "needs-operator"],
  "needs-operator": ["needs-operator", "needs-rework"]
};

/**
 * Detect a Notion "this status/select option does not exist on the board"
 * error so the defensive setStatus can fall back to another status instead of
 * throwing. Notion returns `validation_error` for an unknown option name.
 */
function isOptionMissingError(err: unknown): boolean {
  const e = err as { code?: string; status?: number; message?: string };
  if (e?.code === "validation_error" || e?.status === 400) return true;
  const m = (e?.message ?? "").toLowerCase();
  return m.includes("is not a valid") || m.includes("does not exist") || m.includes("not a property that exists");
}

/** True when the error blames a property (e.g. `CTO Feedback`) that the board lacks. */
function isPropertyMissingError(err: unknown): boolean {
  const e = err as { message?: string };
  const m = (e?.message ?? "").toLowerCase();
  return m.includes("is not a property that exists");
}

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
  const res = await queryDatabaseWithTransientRetry({
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
  const res = await queryDatabaseWithTransientRetry({
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
  const res = await queryDatabaseWithTransientRetry({
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

/** Optional extras for a status write. `reason` is the human-oriented escalation
 *  text persisted to the `CTO Feedback` rich-text property (overwritten, never
 *  appended — idempotent across re-escalations). */
export interface SetStatusOptions {
  prUrl?: string | undefined;
  reason?: string | undefined;
}

/** Build the Notion `properties` patch for a status write. */
function buildStatusProperties(
  status: TaskStatus,
  opts: SetStatusOptions,
  includeReason: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {
    Status: { status: { name: status } }
  };
  if (opts.prUrl) properties["PR URL"] = { url: opts.prUrl };
  if (includeReason && opts.reason) {
    // Notion rich_text segments cap at 2000 chars; the reason is built compact
    // (see escalation-reason.ts) but clamp defensively.
    properties[CTO_FEEDBACK_PROP] = {
      rich_text: [{ type: "text", text: { content: opts.reason.slice(0, 1900) } }]
    };
  }
  return properties;
}

/**
 * Update a task's Status (and optionally PR URL + the `CTO Feedback`
 * escalation reason).
 *
 * Defensive contract (so a missing status/property never strands a task —
 * the 2026-06 `needs-operator`-missing incident):
 *   1. For escalation statuses we walk an ordered fallback chain
 *      (needs-revision → needs-rework → needs-operator). If the primary status
 *      OPTION is missing on the board, we retry with the next one instead of
 *      throwing.
 *   2. If the `CTO Feedback` PROPERTY itself is missing on the board, we retry
 *      the SAME status WITHOUT that property (so the status still lands; the
 *      reason is dropped only as a last resort, and logged).
 *   3. The reason is written on EVERY attempt, so whichever status finally
 *      sticks still carries the human-oriented explanation.
 */
export async function setStatus(
  pageId: string,
  status: TaskStatus,
  prUrlOrOpts?: string | SetStatusOptions
): Promise<void> {
  const opts: SetStatusOptions =
    typeof prUrlOrOpts === "string" ? { prUrl: prUrlOrOpts } : prUrlOrOpts ?? {};

  const chain = ESCALATION_FALLBACK[status] ?? [status];
  let lastErr: unknown = null;
  let written: TaskStatus | null = null;
  let reasonWritten = false;

  for (const candidate of chain) {
    // Try with the reason property first, then without if the property is missing.
    for (const includeReason of opts.reason ? [true, false] : [false]) {
      try {
        await _pagesUpdate({
          page_id: pageId,
          properties: buildStatusProperties(candidate, opts, includeReason)
        });
        written = candidate;
        reasonWritten = includeReason && Boolean(opts.reason);
        break;
      } catch (err) {
        lastErr = err;
        if (includeReason && isPropertyMissingError(err)) {
          // `CTO Feedback` property absent → retry same status without it.
          logger.warn(
            { pageId, status: candidate },
            "notion.setStatus: CTO Feedback property missing — writing status without reason"
          );
          continue;
        }
        if (isOptionMissingError(err) && candidate !== chain[chain.length - 1]) {
          // Status option absent on the board → fall through to next candidate.
          logger.warn(
            { pageId, missing: candidate },
            "notion.setStatus: status option missing on board — falling back to next escalation status"
          );
          break;
        }
        // Not a missing-option/property error (auth, network, etc.) — bubble up.
        throw err;
      }
    }
    if (written) break;
  }

  if (!written) {
    // Exhausted the chain on missing-option errors. Surface the last error.
    throw lastErr ?? new Error(`notion.setStatus: could not set any status in chain for ${status}`);
  }

  if (status !== written) {
    logger.warn({ pageId, requested: status, applied: written }, "notion.setStatus: applied fallback status");
  }
  if (opts.reason && !reasonWritten) {
    logger.warn({ pageId, status: written }, "notion.setStatus: escalation reason NOT persisted (property missing)");
  }

  // LIVE mirror to plyne-app Supabase so the FE reflects daemon progress in
  // real time (pipeline/tabs/PR). Best-effort: no-ops when PLYNE_APP_SUPABASE_*
  // is unset, and swallows all its own errors — must never break the Notion
  // write or the runner. Awaited so the row lands promptly, but a slow/failed
  // Supabase can't throw here (mirrorTaskStatus never rejects).
  await mirrorTaskStatus(pageId, written, opts.prUrl);
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

/**
 * Test helper — swap the `notion.pages.update` implementation used by
 * `setStatus` so the defensive fallback can be exercised without a live
 * workspace. `reset()` restores the real client.
 */
export const __test = {
  injectPagesUpdate(fn: PagesUpdateFn): void {
    _pagesUpdate = fn;
  },
  injectDatabasesQuery(fn: DatabasesQueryFn): void {
    _databasesQuery = fn;
  },
  injectRetrySleep(fn: (ms: number) => Promise<void>): void {
    _retrySleep = fn;
  },
  reset(): void {
    _pagesUpdate = (args) => notion.pages.update(args);
    _databasesQuery = (args) => notion.databases.query(args);
    _retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }
};
