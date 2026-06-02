/**
 * Sentry ingestion poller.
 *
 * Polls the Sentry org-level issues endpoint every 10 min, filters to
 * unresolved + level=error|fatal events in the last 15 min, maps the
 * Sentry project slug to a GMR product key, and emits an IngestSignal
 * for any issue not seen in the last 24h.
 *
 * Verify-before-emit (memory feedback_plyne_verify_before_alert.md):
 * after the initial poll we make a SECOND probe to the per-issue endpoint
 * to confirm the issue is still firing — guards against blip-and-recover
 * false positives that v2's supervisor occasionally fell for.
 *
 * If SENTRY_AUTH_TOKEN or SENTRY_ORG is missing the poller no-ops (logged
 * once at boot) — the rest of the daemon must run even if monitoring isn't
 * configured yet on this VPS.
 */
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createTaskFromSignal } from "./task-creator.js";
import { sharedDedupe } from "./dedupe.js";
import type { IngestSignal } from "./types.js";

const env = loadEnv();

const SENTRY_API_BASE = "https://sentry.io/api/0";

/**
 * Sentry project slug → GMR product key mapping.
 *
 * Sentry uses project slugs (per-app, scoped to the org); we use product
 * keys from the portfolio. Operator updates this table when onboarding
 * a new Sentry project. Unknown slugs are logged + skipped.
 *
 * The legacy v2 env `SENTRY_PROJECT_MAPPINGS` is a CSV in the same shape;
 * v3 hard-codes for type safety + simpler audit. Add an entry here when
 * adding a Sentry project, not at runtime.
 */
const SENTRY_PROJECT_TO_PRODUCT: Record<string, string> = {
  brynx: "brynx",
  marketear: "marketear",
  "crewrev-v2": "crewrev",
  "crewrev": "crewrev",
  dtwin: "dtwin",
  "dtwin-app": "dtwin",
  geoky: "geoky",
  twipaw: "twipaw",
  "vetting-app": "vettinghub",
  "credem-wea-trends": "credem",
  uxtwin: "klenux",
  klenux: "klenux",
  "twin-engine": "graph",
  "cto-v2": "cto",
  "plyne-v3": "cto",
  atwin: "atwin"
};

interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  level?: string;
  count?: string | number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
  project?: { slug?: string };
  status?: string;
}

function severityForLevel(level: string | undefined): "P0" | "P1" | "P2" {
  if (level === "fatal") return "P0";
  if (level === "error") return "P1";
  return "P2";
}

/**
 * Verify-before-emit: re-fetch the single issue and confirm `lastSeen`
 * advanced (or stays recent). Guards against transient blips that get
 * auto-resolved before the next poll.
 */
async function verifyStillFiring(issueId: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SENTRY_API_BASE}/issues/${encodeURIComponent(issueId)}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) {
      logger.warn({ issueId, status: res.status }, "ingestion.sentry: verify probe failed");
      return false;
    }
    const issue = (await res.json()) as SentryIssue;
    if (issue.status === "resolved" || issue.status === "ignored") return false;
    if (!issue.lastSeen) return true; // give it the benefit of the doubt
    const ageMs = Date.now() - new Date(issue.lastSeen).getTime();
    // Still firing if we saw it within the last 30 min.
    return ageMs < 30 * 60 * 1000;
  } catch (err) {
    logger.warn({ issueId, err: err instanceof Error ? err.message : String(err) }, "ingestion.sentry: verify threw");
    return false;
  }
}

export async function sentryPoll(): Promise<number> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG ?? process.env.SENTRY_ORG_SLUG;
  if (!token || !org) {
    return 0;
  }

  const url = new URL(`${SENTRY_API_BASE}/organizations/${encodeURIComponent(org)}/issues/`);
  url.searchParams.set("statsPeriod", "15m");
  url.searchParams.set("query", "is:unresolved level:[error,fatal]");
  url.searchParams.set("limit", "25");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ingestion.sentry: API call threw");
    return 0;
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "ingestion.sentry: non-200 response");
    return 0;
  }

  const issues = (await res.json()) as SentryIssue[];
  if (!Array.isArray(issues) || issues.length === 0) return 0;

  let emitted = 0;
  for (const issue of issues) {
    const slug = issue.project?.slug;
    if (!slug) continue;
    const product = SENTRY_PROJECT_TO_PRODUCT[slug];
    if (!product) {
      logger.debug({ slug }, "ingestion.sentry: unknown project slug, skipping");
      continue;
    }
    const severity = severityForLevel(issue.level);
    if (severity === "P2") continue; // log-only by spec

    const signal: IngestSignal = {
      source: "sentry",
      externalId: issue.id,
      product,
      title: `[${issue.shortId ?? issue.id}] ${issue.title}`.slice(0, 200),
      severity,
      evidenceUrl: issue.permalink ?? `${SENTRY_API_BASE}/issues/${issue.id}/`,
      details: [
        `Sentry issue: ${issue.shortId ?? issue.id}`,
        `Level: ${issue.level ?? "unknown"}`,
        `Count (15m): ${issue.count ?? "?"}`,
        `First seen: ${issue.firstSeen ?? "?"}`,
        `Last seen: ${issue.lastSeen ?? "?"}`
      ].join("\n"),
      ...(issue.firstSeen ? { firstSeenAt: issue.firstSeen } : {}),
      suggestedSkill: "github-pr-review"
    };

    if (!sharedDedupe.shouldEmit(signal)) {
      logger.debug({ sig: sharedDedupe.signature(signal) }, "ingestion.sentry: deduped");
      continue;
    }

    const stillFiring = await verifyStillFiring(issue.id, token);
    if (!stillFiring) {
      logger.info({ issueId: issue.id, slug }, "ingestion.sentry: verify failed (blip recovered) — skipping");
      continue;
    }

    const created = await createTaskFromSignal(signal);
    if (created) emitted += 1;
  }

  if (emitted > 0) {
    logger.info({ emitted }, "ingestion.sentry: poll complete");
  }
  return emitted;
}

let timer: NodeJS.Timeout | undefined;
let stopped = false;

export function startSentryPoller(): void {
  if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_ORG) {
    logger.info("ingestion.sentry: SENTRY_AUTH_TOKEN/SENTRY_ORG not set — poller disabled");
    return;
  }
  const intervalMs = env.INGEST_SENTRY_INTERVAL_MS;
  logger.info({ intervalMs }, "ingestion.sentry: starting poller");
  const tick = async () => {
    if (stopped) return;
    try {
      await sentryPoll();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "ingestion.sentry: tick threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();
}

export function stopSentryPoller(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
