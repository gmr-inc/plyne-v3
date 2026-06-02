/**
 * Notion task creation from ingestion signals.
 *
 * v2 had `notion-task-creation.ts` contract enforcing required fields
 * (Product/Repo/Priority/Effort/PO/Brain words). v3 keeps a minimal
 * version inline here — ingestion-generated tasks always set the same
 * Status (`backlog`), Source flag (`ingestion`), and have a deterministic
 * shape so they don't need the full contract checker.
 *
 * Tasks land in `backlog` (NOT `draft`) — the operator must explicitly
 * promote before Plyne picks them up. Memory `feedback_status_flow_draft_
 * _not_ready.md`: only the operator promotes backlog→draft.
 */
import { Client } from "@notionhq/client";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { lookupRepo } from "./portfolio-map.js";
import type { IngestSignal } from "./types.js";

const env = loadEnv();
const notion = new Client({ auth: env.NOTION_TOKEN });

const CreatedTask = z.object({
  pageId: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url().nullable()
});
export type CreatedTask = z.infer<typeof CreatedTask>;

/**
 * Build the Notion-shaped properties for an ingestion task.
 *
 * Notion DB schema (Tasks v2 — collection 3c35f7a9-bdc5-4153-8567-c09d3584c5ee):
 *   - Name (title) — external_id like INGEST-SENTRY-A1B2C3
 *   - Description (rich_text)
 *   - Product (select)
 *   - Repo (select)
 *   - Priority (select: P0/P1/P2/P3)
 *   - Effort (select: XS/S/M/L/XL)
 *   - Status (status)
 *   - Instructions (rich_text)
 *   - Acceptance Criteria (rich_text)
 *   - Source (select) — set to "ingestion" so the operator can filter
 */
function buildProperties(signal: IngestSignal, externalId: string, repo: string) {
  const instructions = [
    `**Auto-ingested from ${signal.source}**`,
    "",
    `**Issue**: ${signal.title}`,
    `**Severity**: ${signal.severity}`,
    `**Product**: ${signal.product}`,
    `**Evidence**: ${signal.evidenceUrl}`,
    signal.firstSeenAt ? `**First seen**: ${signal.firstSeenAt}` : "",
    signal.vendor ? `**Vendor outage**: this is a third-party (${signal.product}) — Plyne will not fix vendor-side; track + degrade gracefully.` : "",
    "",
    "**Details**:",
    signal.details,
    "",
    "**Goal**: investigate root cause + open a PR with the fix + add a regression test.",
    "",
    "**Boundaries**:",
    "- Reproduce the failure locally before touching code.",
    "- If the issue is a transient external 5xx and not reproducible after 3 attempts, set the marker file to `blocked` with a one-line note and exit.",
    "- DO NOT bundle unrelated changes into the fix PR."
  ]
    .filter(Boolean)
    .join("\n");

  const acceptance = [
    "run: npm test --silent expect_exit: 0",
    "run: git log --format=%s -1 expect_exit: 0",
    `run: grep -RIl --include='*.ts' -E 'regression|fix' src/ expect_exit: 0`
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {
    Name: {
      title: [{ type: "text", text: { content: externalId } }]
    },
    Description: {
      rich_text: [{ type: "text", text: { content: signal.title.slice(0, 1900) } }]
    },
    Product: { select: { name: signal.product } },
    Repo: { select: { name: repo } },
    Priority: { select: { name: signal.severity } },
    Effort: { select: { name: "S" } },
    Status: { status: { name: "backlog" } },
    Instructions: {
      rich_text: [{ type: "text", text: { content: instructions.slice(0, 1900) } }]
    },
    "Acceptance Criteria": {
      rich_text: [{ type: "text", text: { content: acceptance.slice(0, 1900) } }]
    },
    Source: { select: { name: "ingestion" } }
  };
  return properties;
}

/**
 * Generate a short, stable external id slug from the signal. Format:
 *   INGEST-<SOURCE>-<EXTERNAL_ID_TAIL>
 * Truncated to 60 chars (Notion title limit is generous but readability
 * matters more — the full vendor id is in `Instructions`).
 */
export function buildExternalId(signal: IngestSignal): string {
  const tail = signal.externalId.replace(/[^A-Za-z0-9-]+/g, "").slice(-12) || "UNK";
  return `INGEST-${signal.source.toUpperCase()}-${tail}`.slice(0, 60);
}

/**
 * Create a Notion task from an IngestSignal. Returns `null` on Notion
 * API failure (logged but not thrown — ingestion must not crash the
 * daemon).
 *
 * Validates the product → repo mapping FIRST: emitting a task with a
 * Repo that isn't a valid select option crashes downstream (Plyne brain
 * runs `validateAllowlist()` on the Repo property).
 */
export async function createTaskFromSignal(signal: IngestSignal): Promise<CreatedTask | null> {
  const repo = lookupRepo(signal.product);
  if (!repo) {
    logger.warn(
      { source: signal.source, product: signal.product, title: signal.title },
      "ingestion.task-creator: unknown product — skipping (update portfolio-map.ts)"
    );
    return null;
  }

  const externalId = buildExternalId(signal);
  const properties = buildProperties(signal, externalId, repo);

  try {
    const res = await notion.pages.create({
      parent: { database_id: env.NOTION_TASKS_DB_ID },
      properties
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = res as any;
    const parsed = CreatedTask.safeParse({
      pageId: page.id,
      externalId,
      url: typeof page.url === "string" ? page.url : null
    });
    if (!parsed.success) {
      logger.warn({ err: parsed.error.format() }, "ingestion.task-creator: Notion response unparseable");
      return null;
    }
    logger.info(
      { externalId, source: signal.source, product: signal.product, severity: signal.severity, url: parsed.data.url },
      "ingestion.task-creator: created Notion task"
    );
    return parsed.data;
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        source: signal.source,
        product: signal.product
      },
      "ingestion.task-creator: Notion create failed"
    );
    return null;
  }
}
