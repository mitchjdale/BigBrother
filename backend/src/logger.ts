import pino from "pino";
import { config } from "./config.js";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Central structured logger (pino).
 *
 * - Emits newline-delimited JSON in production, which any log aggregator
 *   (Datadog, Grafana Loki, ELK/OpenSearch, CloudWatch, …) can ingest directly
 *   from stdout — this is the "integrate with external tools" requirement.
 * - Pretty-prints in development for readability (set NODE_ENV=production to get
 *   raw JSON, or LOG_PRETTY=false to force JSON everywhere).
 * - Redacts secrets so tokens never end up in logs.
 */
const usePretty = process.env.LOG_PRETTY === "false" ? false : !isProduction;

export const logger = pino({
  level: config.logLevel,
  base: { service: "bigbrother-backend" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "*.ghToken",
      "*.token",
      "ghToken",
      "token",
    ],
    remove: true,
  },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service",
          },
        },
      }
    : {}),
});

/** Scoped child logger for a given module, e.g. `log("planner")`. */
export function log(module: string) {
  return logger.child({ module });
}

export type Logger = typeof logger;
