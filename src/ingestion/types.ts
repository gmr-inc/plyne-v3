/**
 * Plyne v3 ingestion module — shared types.
 *
 * The ingestion module is a THIN bridge between external monitoring vendors
 * (Sentry, BetterStack, Braintrust, Statuspage/uptime) and the Plyne v3
 * Notion task backlog. v2 had a sprawling supervisor + cross-collector
 * subsystem (~30 modules) that did this and a lot more (root-cause analysis,
 * RAG memory, escalation chains). v3 deletes all of that and keeps only:
 *
 *   poll vendor → verify-still-firing → dedupe → create Notion task
 *
 * No analysis. No RAG. No escalation. If the bug needs a human, the
 * created task surfaces in the operator's Notion inbox and the operator
 * routes from there.
 *
 * See also:
 *   - feedback_plyne_verify_before_alert.md (verify-before-emit pattern)
 *   - feedback_plyne_is_the_cto.md (every Sentry/BS hit = Plyne task)
 */
import { z } from "zod";

/**
 * Severity gate. Only P0/P1 signals create tasks; P2/P3 are log-only
 * (counted in metrics but don't pollute the backlog).
 */
export const Severity = z.enum(["P0", "P1", "P2", "P3"]);
export type Severity = z.infer<typeof Severity>;

/**
 * Source vendor — used both for dedupe signatures and the Notion task
 * external_id prefix (`INGEST-<source>-<short_id>`).
 */
export const IngestSource = z.enum([
  "sentry",
  "betterstack",
  "braintrust",
  "statuspage"
]);
export type IngestSource = z.infer<typeof IngestSource>;

/**
 * One thing the ingestion module emits.
 *
 * Fields are deliberately flat (no nested vendor blobs) so the task-creator
 * can build a uniform Notion payload regardless of source. Vendor-specific
 * detail goes into `evidence_url` (operator clicks through) and the
 * `details` markdown blob (auto-pasted into Instructions).
 */
export interface IngestSignal {
  /** Vendor that produced the signal. */
  source: IngestSource;
  /**
   * Stable identifier WITHIN the source (Sentry issue id, BetterStack
   * pattern hash, Braintrust experiment id, Statuspage monitor id).
   * Combined with `source` + `product` to form the dedupe signature.
   */
  externalId: string;
  /** GMR product key (matches portfolio.json keys). */
  product: string;
  /** Short, action-oriented title — becomes the Notion task Description. */
  title: string;
  /** Severity gate. Only P0/P1 create tasks. */
  severity: Severity;
  /** Direct link the operator can click to see vendor-side detail. */
  evidenceUrl: string;
  /** Free-form markdown — gets pasted verbatim into Instructions. */
  details: string;
  /**
   * Optional: when the vendor told us the issue first fired. Used in the
   * task body, not in dedupe.
   */
  firstSeenAt?: string;
  /**
   * Optional: a hint about which Claude skill to attach to the task
   * (passed through to the brain). Most signals are bug fixes →
   * "github-pr-review" is the natural default.
   */
  suggestedSkill?: string;
  /**
   * Statuspage-only: whether the outage is on a third-party vendor
   * (Anthropic, Supabase, Vercel) vs our own infra. Vendor outages get
   * filed but flagged so the operator can decide not to auto-promote.
   */
  vendor?: boolean;
}

/**
 * Result of `task-creator.createTaskFromSignal()` — surfaced for tests
 * and the runtime log.
 */
export interface CreatedTaskRef {
  notionPageId: string;
  externalId: string;
  prUrl: never; // no PR at ingestion time — the executor will open it later
}
