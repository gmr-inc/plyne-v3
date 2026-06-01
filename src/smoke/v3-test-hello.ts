/**
 * Smoke test: spawn Claude on a synthetic [V3-TEST-HELLO-001] task without
 * needing Notion. Proves the executor → stack-loader → claude CLI wiring
 * end-to-end on the VPS before we flip a real task to `ready`.
 *
 * Run:
 *   PLYNE_MODE=smoke npm run smoke
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { executeTask } from "../executor/claude-cli-executor.js";
import type { Task } from "../notion/client.js";
import { logger } from "../config/logger.js";

const fakeTask: Task = {
  id: "smoke-fake-id",
  externalId: "V3-TEST-HELLO-001",
  title: "Plyne v3 hello-world smoke test",
  status: "ready",
  product: "cto-v2",
  repo: "gmr-inc/plyne-v3",
  effort: "XS",
  instructions:
    "Write a file `hello.txt` containing the line `hello from plyne-v3 + claude-opus-4-8`. Then write the marker file `PLYNE_V3_DONE.txt` containing `smoke ok`.",
  acceptanceCriteria:
    "1. `hello.txt` exists and contains the required line.\n2. `PLYNE_V3_DONE.txt` exists and contains `smoke ok`.",
  stack: {
    mcpServers: [],
    skills: [],
    computerUse: false,
    model: undefined
  },
  prUrl: null
};

async function main(): Promise<void> {
  logger.info("smoke: starting V3-TEST-HELLO-001");
  const result = (await executeTask(fakeTask)) as ReturnType<typeof executeTask> extends Promise<infer R> ? R : never;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  const cwd: string = r.worktreeCwd;
  const helloPath = path.join(cwd, "hello.txt");
  const donePath = path.join(cwd, "PLYNE_V3_DONE.txt");

  const helloExists = fs.existsSync(helloPath);
  const doneExists = fs.existsSync(donePath);
  const helloContents = helloExists ? fs.readFileSync(helloPath, "utf8").trim() : null;
  const doneContents = doneExists ? fs.readFileSync(donePath, "utf8").trim() : null;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: helloExists && doneExists,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stack: r.stackSummary,
        worktree: cwd,
        helloExists,
        doneExists,
        helloContents,
        doneContents,
        stderrTail: r.stderr ? String(r.stderr).slice(-400) : ""
      },
      null,
      2
    )
  );

  if (r.worktreeDestroy) r.worktreeDestroy();
  process.exit(helloExists && doneExists ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("smoke fatal:", err);
  process.exit(2);
});
