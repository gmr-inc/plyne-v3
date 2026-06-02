/**
 * BetterStack ingestion poller.
 *
 * Polls the BetterStack telemetry-API for error-level log clusters every
 * 5 minutes. When a single source emits >5 errors in the last 5 min, we
 * emit a P1 IngestSignal.
 *
 * Unlike Sentry, BetterStack logs are per-source (typically per-product
 * application). Source ID → product mapping is hand-maintained below.
 *
 * Verify-before-emit: we cross-check the vendor's actual Statuspage
 * status BEFORE alerting on Anthropic/Notion/Vercel/Supabase log spikes
 * — those vendors going down cause our app logs to spike with errors
 * that aren't our bug. The statuspage poller files vendor outages
 * separately so we don't double-create tasks.
 *
 * v2 reference: src/cto/collectors/betterstack-errors.ts +
 * memory reference_betterstack_plyne_query_basics.md.
 */
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createTaskFromSignal } from "./task-creator.js";
import { sharedDedupe } from "./dedupe.js";
import type { IngestSignal } from "./types.js";

const env = loadEnv();

const BS_TELEMETRY_API = "https://telemetry.betterstack.com/api/v2";

/**
 * BetterStack source IDs (numeric, assigned at source creation) →
 * GMR product key. cto-v2 v2 daemon uses source 2440243 (Plyne logs)
 * — most product apps use their own. Operator updates this when adding
 * a new BetterStack source.
 */
const BS_SOURCE_TO_PRODUCT: Record<string, string> = {
  "2440243": "cto", // cto-v2 (Plyne v2 logs)
  // Per-product sources to be added as products onboard BetterStack.
  // The default behaviour for an unknown source is to skip — see
  // `productForSource` below.
};

function productForSource(sourceId: string): string | null {
  return BS_SOURCE_TO_PRODUCT[sourceId] ?? null;
}

interface BSErrorClusterRow {
  source_id?: string;
  pattern?: string;
  count?: number;
  latest_at?: string;
  sample_message?: string;
}

/**
 * Build a ClickHouse-flavour SQL that the BetterStack proxy understands.
 *
 * Counts error/fatal-level events grouped by `_pattern` (BetterStack
 * auto-strips IDs/numbers from messages — gives a stable cluster key)
 * for the last `windowMinutes` minutes. Returns clusters with count >
 * `minCount`.
 */
function buildErrorQuerySql(windowMinutes: number, minCount: number): string {
  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - windowMinutes * 60;
  return `SELECT source_id, _pattern AS pattern, count() AS count,
       max(dt) AS latest_at, any(raw) AS sample_message
FROM (
  SELECT source_id, dt, raw, _pattern
  FROM remote_log
  WHERE dt >= toDateTime64(${sinceUnixSeconds}, 0, 'UTC')
    AND (raw LIKE '%"level":"error"%' OR raw LIKE '%"level":"fatal"%')
)
GROUP BY source_id, pattern
HAVING count >= ${minCount}
ORDER BY count DESC
LIMIT 20
FORMAT JSONEachRow`;
}

async function queryClickhouse(sql: string): Promise<BSErrorClusterRow[]> {
  const username = process.env.BETTERSTACK_QUERY_USERNAME;
  const password = process.env.BETTERSTACK_QUERY_PASSWORD;
  const endpoint = process.env.BETTERSTACK_QUERY_ENDPOINT;
  if (!username || !password || !endpoint) {
    logger.debug("ingestion.betterstack: ClickHouse proxy creds missing — falling back to /metrics");
    return [];
  }
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        "Content-Type": "text/plain"
      },
      body: sql
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ingestion.betterstack: ClickHouse threw");
    return [];
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "ingestion.betterstack: ClickHouse non-200");
    return [];
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const rows: BSErrorClusterRow[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as BSErrorClusterRow);
    } catch {
      // Skip non-JSON noise.
    }
  }
  return rows;
}

/**
 * Vendor status cross-check — used to suppress error spikes that are
 * caused by an upstream vendor outage rather than our bug. Reads the
 * statuspage poller's last cached state. If any tier1 vendor (Anthropic,
 * Supabase) is currently red, we suppress new BS error tasks for 30 min.
 */
function vendorOutageInProgress(): boolean {
  // Lazy-import to avoid a circular dep; statuspage module exposes the flag.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sp = require("./statuspage.js") as { isAnyTier1VendorRed?: () => boolean };
    return typeof sp.isAnyTier1VendorRed === "function" ? sp.isAnyTier1VendorRed() : false;
  } catch {
    return false;
  }
}

export async function betterstackPoll(): Promise<number> {
  const token = process.env.BETTERSTACK_API_TOKEN ?? process.env.BETTERSTACK_QUERY_USERNAME;
  if (!token) return 0;

  if (vendorOutageInProgress()) {
    logger.info("ingestion.betterstack: tier1 vendor outage in progress — suppressing this cycle");
    return 0;
  }

  const sql = buildErrorQuerySql(5, 5);
  const rows = await queryClickhouse(sql);
  if (rows.length === 0) return 0;

  let emitted = 0;
  for (const row of rows) {
    const sourceId = String(row.source_id ?? "");
    const product = productForSource(sourceId);
    if (!product) {
      logger.debug({ sourceId }, "ingestion.betterstack: unknown source, skipping");
      continue;
    }
    const pattern = String(row.pattern ?? "");
    if (!pattern) continue;

    const signal: IngestSignal = {
      source: "betterstack",
      externalId: `${sourceId}:${pattern.slice(0, 80)}`,
      product,
      title: `BetterStack error spike: ${pattern.slice(0, 140)}`,
      severity: "P1",
      evidenceUrl: `https://telemetry.betterstack.com/team/sources/${sourceId}/logs?q=${encodeURIComponent(pattern.slice(0, 60))}`,
      details: [
        `BetterStack source: ${sourceId}`,
        `Pattern: ${pattern}`,
        `Count (5m): ${row.count ?? "?"}`,
        `Latest: ${row.latest_at ?? "?"}`,
        row.sample_message ? `Sample: \`${String(row.sample_message).slice(0, 400)}\`` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      ...(row.latest_at ? { firstSeenAt: row.latest_at } : {}),
      suggestedSkill: "github-pr-review"
    };

    if (!sharedDedupe.shouldEmit(signal)) {
      logger.debug({ sig: sharedDedupe.signature(signal) }, "ingestion.betterstack: deduped");
      continue;
    }

    const created = await createTaskFromSignal(signal);
    if (created) emitted += 1;
  }

  if (emitted > 0) {
    logger.info({ emitted }, "ingestion.betterstack: poll complete");
  }
  return emitted;
}

let timer: NodeJS.Timeout | undefined;
let stopped = false;

export function startBetterstackPoller(): void {
  if (!env.BETTERSTACK_API_TOKEN && !process.env.BETTERSTACK_QUERY_USERNAME) {
    logger.info("ingestion.betterstack: BETTERSTACK_API_TOKEN/QUERY_USERNAME not set — poller disabled");
    return;
  }
  const intervalMs = env.INGEST_BETTERSTACK_INTERVAL_MS;
  logger.info({ intervalMs }, "ingestion.betterstack: starting poller");
  const tick = async () => {
    if (stopped) return;
    try {
      await betterstackPoll();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "ingestion.betterstack: tick threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();
}

export function stopBetterstackPoller(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
