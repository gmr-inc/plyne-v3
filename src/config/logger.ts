import pino from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "plyne-v3" }
});

export type Logger = typeof logger;
