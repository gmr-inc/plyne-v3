/**
 * Braintrust ingestion poller.
 *
 * Polls the Braintrust public API every 30 min, lists recent experiments
 * grouped by project, and looks for score regressions versus the previous
 * experiment in the same project. When the average score drops below a
 * threshold (or below the previous experiment's average minus a delta)
 * we emit a P2 signal — Braintrust regressions don't usually block prod,
 * but they need a human look.
 *
 * Note on severity gate: P2 ingestion signals are LOG-ONLY per spec —
 * they accumulate in the daemon log + metrics but do NOT create Notion
 * tasks. If the operator wants Braintrust regressions to file tasks,
 * lift the gate by raising the severity to P1 here.
 *
 * No-op when BRAINTRUST_API_KEY is missing.
 */
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createTaskFromSignal } from "./task-creator.js";
import { sharedDedupe } from "./dedupe.js";
import type { IngestSignal, Severity } from "./types.js";

const env = loadEnv();

const BT_API_BASE = "https://api.braintrust.dev/v1";

/**
 * Braintrust project slug → GMR product key. Each Braintrust project
 * is typically named after the product. Adjust as new ones are wired.
 */
const BT_PROJECT_TO_PRODUCT: Record<string, string> = {
  "cto-v2": "cto",
  "plyne-v3": "cto",
  marketear: "marketear",
  brynx: "brynx",
  crewrev: "crewrev",
  dtwin: "dtwin",
  geoky: "geoky",
  klenux: "klenux",
  graph: "graph"
};

interface BTExperimentSummary {
  id: string;
  project_id: string;
  project_name?: string;
  name?: string;
  created?: string;
  metrics?: { score?: { mean?: number; lower?: number; upper?: number } };
}

interface BTListResponse {
  objects?: BTExperimentSummary[];
}

async function btFetch(path: string, token: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${BT_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) {
      logger.warn({ path, status: res.status }, "ingestion.braintrust: non-200");
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, "ingestion.braintrust: fetch threw");
    return null;
  }
}

/**
 * Severity for an eval score drop. Configurable threshold — defaults are
 * conservative to avoid noise.
 */
function severityForDrop(prev: number, curr: number): Severity {
  const delta = prev - curr;
  if (delta >= 0.25) return "P1"; // catastrophic regression
  if (delta >= 0.1) return "P2";
  return "P3";
}

export async function braintrustPoll(): Promise<number> {
  const token = process.env.BRAINTRUST_API_KEY;
  if (!token) return 0;

  // List the 50 most recent experiments across all projects (org-scoped).
  const list = (await btFetch("/experiment?limit=50", token)) as BTListResponse | null;
  if (!list?.objects?.length) return 0;

  // Group by project, sort each by created desc, compare top-2.
  const byProject = new Map<string, BTExperimentSummary[]>();
  for (const e of list.objects) {
    const key = e.project_name ?? e.project_id;
    if (!key) continue;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(e);
  }

  let emitted = 0;
  for (const [projectName, experiments] of byProject) {
    const product = BT_PROJECT_TO_PRODUCT[projectName];
    if (!product) {
      logger.debug({ projectName }, "ingestion.braintrust: unknown project, skipping");
      continue;
    }
    experiments.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
    if (experiments.length < 2) continue;
    const curr = experiments[0];
    const prev = experiments[1];
    const currScore = curr?.metrics?.score?.mean;
    const prevScore = prev?.metrics?.score?.mean;
    if (typeof currScore !== "number" || typeof prevScore !== "number") continue;
    if (currScore >= prevScore) continue; // no regression
    const severity = severityForDrop(prevScore, currScore);

    const signal: IngestSignal = {
      source: "braintrust",
      externalId: `${projectName}:${curr?.id ?? "unknown"}`,
      product,
      title: `Braintrust score regression: ${projectName} (${prevScore.toFixed(3)} → ${currScore.toFixed(3)})`,
      severity,
      evidenceUrl: `https://braintrust.dev/app/gmr/p/${encodeURIComponent(projectName)}/experiments`,
      details: [
        `Project: ${projectName}`,
        `Previous experiment: ${prev?.name ?? prev?.id ?? "?"} — score ${prevScore.toFixed(3)}`,
        `Current experiment: ${curr?.name ?? curr?.id ?? "?"} — score ${currScore.toFixed(3)}`,
        `Delta: -${(prevScore - currScore).toFixed(3)}`
      ].join("\n"),
      ...(curr?.created ? { firstSeenAt: curr.created } : {}),
      suggestedSkill: "github-pr-review"
    };

    // Severity gate: P2/P3 are log-only per spec.
    if (severity === "P2" || severity === "P3") {
      logger.info(
        { product, projectName, prevScore, currScore, severity },
        "ingestion.braintrust: regression detected (log-only, below severity gate)"
      );
      continue;
    }

    if (!sharedDedupe.shouldEmit(signal)) continue;
    const created = await createTaskFromSignal(signal);
    if (created) emitted += 1;
  }

  if (emitted > 0) {
    logger.info({ emitted }, "ingestion.braintrust: poll complete");
  }
  return emitted;
}

let timer: NodeJS.Timeout | undefined;
let stopped = false;

export function startBraintrustPoller(): void {
  if (!env.BRAINTRUST_API_KEY) {
    logger.info("ingestion.braintrust: BRAINTRUST_API_KEY not set — poller disabled");
    return;
  }
  const intervalMs = env.INGEST_BRAINTRUST_INTERVAL_MS;
  logger.info({ intervalMs }, "ingestion.braintrust: starting poller");
  const tick = async () => {
    if (stopped) return;
    try {
      await braintrustPoll();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "ingestion.braintrust: tick threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();
}

export function stopBraintrustPoller(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
