/**
 * Plyne v3 ingestion module — public entry.
 *
 * Wires the four pollers (Sentry, BetterStack, Braintrust, Statuspage)
 * to the orchestrator boot. Each poller manages its own setTimeout
 * cadence — we keep them independent so a slow vendor (Sentry rate
 * limit, BetterStack ClickHouse 5xx) doesn't stall the rest.
 *
 * Pollers are no-ops when their vendor credentials are missing. The
 * daemon must boot cleanly even when only a subset of monitoring is
 * configured (greenfield VPS, dev environment).
 */
import { startSentryPoller, stopSentryPoller } from "./sentry.js";
import { startBetterstackPoller, stopBetterstackPoller } from "./betterstack.js";
import { startBraintrustPoller, stopBraintrustPoller } from "./braintrust.js";
import { startStatuspagePoller, stopStatuspagePoller } from "./statuspage.js";
import { logger } from "../config/logger.js";

export function startIngestion(): void {
  logger.info("ingestion: starting all pollers");
  startSentryPoller();
  startBetterstackPoller();
  startBraintrustPoller();
  startStatuspagePoller();
}

export function stopIngestion(): void {
  logger.info("ingestion: stopping all pollers");
  stopSentryPoller();
  stopBetterstackPoller();
  stopBraintrustPoller();
  stopStatuspagePoller();
}

export type { IngestSignal, Severity, IngestSource } from "./types.js";
export { IngestDedupe, sharedDedupe } from "./dedupe.js";
export { createTaskFromSignal, buildExternalId } from "./task-creator.js";
export { lookupRepo, isKnownProduct, PORTFOLIO } from "./portfolio-map.js";
export { isAnyTier1VendorRed } from "./statuspage.js";
