/**
 * Statuspage / uptime monitor ingestion poller.
 *
 * Polls the BetterStack Uptime API every 2 min to check each monitor's
 * current status. When a monitor transitions to a non-OK state OR its
 * latest probe latency exceeds 5 s we emit a P0 signal — uptime outages
 * are the most user-facing failure mode.
 *
 * Vendor flag: monitors tagged as third-party (Anthropic, Supabase,
 * Vercel, Notion, …) emit signals with `vendor=true`. The operator
 * decides whether to promote those to a task or just log — Plyne can't
 * fix Anthropic.
 *
 * Side-effect: maintains an in-memory map of tier1-vendor outage state
 * that the BetterStack poller reads to suppress error-spike alerts
 * during vendor outages (cross-collector deduplication).
 *
 * v2 reference: src/vendor-status/poller.ts + vendor-map.ts.
 */
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createTaskFromSignal } from "./task-creator.js";
import { sharedDedupe } from "./dedupe.js";
import type { IngestSignal } from "./types.js";

const env = loadEnv();

const BS_UPTIME_API = "https://uptime.betterstack.com/api/v2";

/**
 * Monitor URL → (product key, vendor flag, tier). Hand-maintained so
 * we know the blast radius of each monitor. Unknown URLs are skipped.
 *
 * Tier semantics (memory `reference_betterstack_vendor_monitoring.md`):
 *   tier1 = multi-product vendor (Anthropic, Supabase, Vercel)
 *   tier2 = single-product critical path
 *   tier3 = cosmetic single-feature
 *
 * For non-vendor (own infra) monitors, set `vendor: false` and `tier`
 * reflects the product blast radius (always tier2 — single product).
 */
interface MonitorTarget {
  product: string;
  vendor: boolean;
  tier: "tier1" | "tier2" | "tier3";
}

const MONITOR_TARGETS: Record<string, MonitorTarget> = {
  // Own infra
  "https://marketear.gmr.com": { product: "marketear", vendor: false, tier: "tier2" },
  "https://brynx.gmr.com": { product: "brynx", vendor: false, tier: "tier2" },
  "https://dtwin.app": { product: "dtwin", vendor: false, tier: "tier2" },
  "https://geoky.ai": { product: "geoky", vendor: false, tier: "tier2" },
  // Third-party (tier1 — affects multiple products)
  "https://status.anthropic.com/api/v2/status.json": { product: "cto", vendor: true, tier: "tier1" },
  "https://status.supabase.com/api/v2/status.json": { product: "cto", vendor: true, tier: "tier1" },
  "https://www.vercel-status.com/api/v2/status.json": { product: "cto", vendor: true, tier: "tier1" },
  "https://status.notion.com/api/v2/status.json": { product: "cto", vendor: true, tier: "tier1" }
};

interface BSMonitor {
  id: string;
  attributes: {
    url?: string;
    pronounceable_name?: string;
    /** "up" | "down" | "validating" | "paused" | "maintenance" */
    status?: string;
    last_checked_at?: string;
    response_times?: { current?: number };
  };
}

/**
 * In-memory cache of tier1-vendor outage state. The BetterStack errors
 * poller reads this to suppress cascade alerts.
 */
const tier1VendorOutages = new Set<string>();

export function isAnyTier1VendorRed(): boolean {
  return tier1VendorOutages.size > 0;
}

async function fetchAllMonitors(token: string): Promise<BSMonitor[]> {
  try {
    const res = await fetch(`${BS_UPTIME_API}/monitors?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "ingestion.statuspage: monitors API non-200");
      return [];
    }
    const json = (await res.json()) as { data?: BSMonitor[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ingestion.statuspage: monitors API threw");
    return [];
  }
}

export async function statuspagePoll(): Promise<number> {
  const token = process.env.BETTERSTACK_UPTIME_TOKEN ?? process.env.BETTERSTACK_API_TOKEN;
  if (!token) return 0;

  const monitors = await fetchAllMonitors(token);
  if (monitors.length === 0) return 0;

  let emitted = 0;
  const currentTier1Outages = new Set<string>();
  for (const m of monitors) {
    const url = m.attributes.url;
    if (!url) continue;
    const target = MONITOR_TARGETS[url];
    if (!target) continue;

    const status = m.attributes.status ?? "unknown";
    const responseMs = m.attributes.response_times?.current ?? 0;
    const isDown = status === "down" || status === "validating";
    const isSlow = responseMs > 5000;
    const isOutage = isDown || isSlow;

    if (target.vendor && target.tier === "tier1" && isOutage) {
      currentTier1Outages.add(url);
    }

    if (!isOutage) continue;

    const signal: IngestSignal = {
      source: "statuspage",
      externalId: m.id,
      product: target.product,
      title: `${target.vendor ? "Vendor outage" : "Outage"}: ${m.attributes.pronounceable_name ?? url} (${status})`,
      severity: "P0",
      evidenceUrl: `https://uptime.betterstack.com/team/monitors/${m.id}`,
      details: [
        `Monitor: ${url}`,
        `Status: ${status}`,
        `Response time: ${responseMs}ms`,
        `Last checked: ${m.attributes.last_checked_at ?? "?"}`,
        target.vendor ? `Vendor outage (tier=${target.tier}) — Plyne cannot fix; track + degrade gracefully.` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      ...(m.attributes.last_checked_at ? { firstSeenAt: m.attributes.last_checked_at } : {}),
      vendor: target.vendor,
      suggestedSkill: "github-pr-review"
    };

    if (!sharedDedupe.shouldEmit(signal)) continue;
    const created = await createTaskFromSignal(signal);
    if (created) emitted += 1;
  }

  // Update tier1-vendor outage state for cross-collector dedup.
  tier1VendorOutages.clear();
  for (const u of currentTier1Outages) tier1VendorOutages.add(u);

  if (emitted > 0) {
    logger.info({ emitted, tier1Outages: tier1VendorOutages.size }, "ingestion.statuspage: poll complete");
  }
  return emitted;
}

let timer: NodeJS.Timeout | undefined;
let stopped = false;

export function startStatuspagePoller(): void {
  if (!env.BETTERSTACK_API_TOKEN && !process.env.BETTERSTACK_UPTIME_TOKEN) {
    logger.info("ingestion.statuspage: BETTERSTACK_UPTIME_TOKEN/API_TOKEN not set — poller disabled");
    return;
  }
  const intervalMs = env.INGEST_STATUSPAGE_INTERVAL_MS;
  logger.info({ intervalMs }, "ingestion.statuspage: starting poller");
  const tick = async () => {
    if (stopped) return;
    try {
      await statuspagePoll();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "ingestion.statuspage: tick threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();
}

export function stopStatuspagePoller(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
