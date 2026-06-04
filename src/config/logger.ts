import pino from "pino";
import { loadEnv } from "./env.js";
import { createBetterstackPinoStream } from "../observability/betterstack.js";

const env = loadEnv();

// Self-observability: when BetterStack is configured, tee every structured log
// line to it (in addition to stdout, which pm2/journald still capture). The
// stream batches + ships best-effort and never blocks the daemon. When
// BetterStack is unconfigured this returns undefined and we log to stdout only
// — byte-for-byte the pre-observability behaviour.
const betterstackStream = createBetterstackPinoStream();

export const logger = betterstackStream
  ? pino(
      { level: env.LOG_LEVEL, base: { service: "plyne-v3" } },
      pino.multistream([
        { level: env.LOG_LEVEL, stream: process.stdout },
        { level: env.LOG_LEVEL, stream: betterstackStream }
      ])
    )
  : pino({ level: env.LOG_LEVEL, base: { service: "plyne-v3" } });

export type Logger = typeof logger;
