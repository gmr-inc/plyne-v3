/**
 * In-memory dedupe for ingestion signals.
 *
 * Why not Notion-side dedupe? Notion query latency + rate limits make it
 * too slow to scan every poll. Process-local cache with a 24h TTL is good
 * enough: on daemon restart we re-create the same task at worst once, and
 * the operator can dismiss the dupe.
 *
 * Signature: `<source>:<product>:<sha1(title)>`. We hash the title rather
 * than use externalId because Sentry sometimes assigns a new id to the
 * same logical issue when groupingscript fingerprints rotate — we want to
 * stay deduped across that.
 */
import { createHash } from "node:crypto";
import type { IngestSignal } from "./types.js";

export interface DedupeEntry {
  signature: string;
  firstSeenMs: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class IngestDedupe {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Compute the dedupe signature for a signal. Stable across daemon
   * restarts (so an operator-side audit can re-derive it).
   */
  signature(signal: IngestSignal): string {
    const titleHash = createHash("sha1")
      .update(signal.title.trim().toLowerCase())
      .digest("hex")
      .slice(0, 12);
    return `${signal.source}:${signal.product}:${titleHash}`;
  }

  /**
   * Return true the first time we see a signal in the TTL window. Returns
   * false on subsequent occurrences (caller skips).
   *
   * Also opportunistically prunes expired entries — keeps the map bounded
   * without needing a separate sweeper.
   */
  shouldEmit(signal: IngestSignal): boolean {
    const now = this.now();
    this.pruneExpired(now);
    const sig = this.signature(signal);
    if (this.entries.has(sig)) return false;
    this.entries.set(sig, now);
    return true;
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }

  private pruneExpired(now: number): void {
    for (const [sig, ts] of this.entries) {
      if (now - ts > this.ttlMs) this.entries.delete(sig);
    }
  }
}

/** Singleton — collectors share the same dedupe cache. */
export const sharedDedupe = new IngestDedupe();
