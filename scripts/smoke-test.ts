/**
 * Plyne MCP smoke test.
 *
 * Exercises the MCP server against an in-process MockPlyneClient so we don't
 * need the backend REST live to prove the surface works end-to-end.
 *
 * Run:
 *   PLYNE_PAT=dev tsx scripts/smoke-test.ts
 */
import { createPlyneMcpServer } from "../src/mcp/server.js";
import type {
  PlyneClient,
  TaskCreateInput,
  TaskListInput,
  TaskLogsInput,
} from "../src/mcp/client.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/* ───── Mock backend ───── */
const tasks = new Map<string, Awaited<ReturnType<PlyneClient["getTask"]>>>();

const mock: PlyneClient = {
  async createTask(input: TaskCreateInput) {
    const id = `tsk_${Math.random().toString(36).slice(2, 10)}`;
    tasks.set(id, {
      id,
      title: input.title,
      status: "draft",
      product: input.product,
      repo: input.repo ?? `gmr-inc/${input.product}`,
      instructions_md: input.instructions_md,
      acceptance_criteria: input.acceptance_criteria,
      pr_url: undefined,
      mcp_servers: input.mcp_servers ?? [],
      skills: input.skills ?? [],
      computer_use: input.computer_use ?? false,
      model: input.model ?? "claude-opus-4-8",
      cost_usd: 0,
      attempts: 0,
    });
    return { id, url: `https://plyne.dev/tasks/${id}`, status: "draft" };
  },
  async listTasks(input: TaskListInput) {
    return [...tasks.values()]
      .filter((t) => !input.product || t.product === input.product)
      .slice(0, input.limit ?? 50)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, product: t.product, pr_url: t.pr_url }));
  },
  async getTask(id: string) {
    const t = tasks.get(id);
    if (!t) throw new Error(`task not found: ${id}`);
    return t;
  },
  async abortTask(id) {
    const t = tasks.get(id);
    if (t) t.status = "abandoned";
    return { ok: !!t };
  },
  async getLogs(id: string, opts) {
    return {
      lines: [
        { t: new Date().toISOString(), lvl: "info", msg: `task ${id} bootstrap` },
        { t: new Date().toISOString(), lvl: "info", msg: `stack-loader: mcp=github,notion skills=github-pr-review` },
      ].slice(0, opts.limit ?? 200),
    };
  },
  async quotaMe() {
    return {
      user: "alberto@dtwin.now",
      session: 42,
      week: 17,
      plan: "max-20x",
      per_model: { "claude-opus-4-8": 1_240_000, "claude-sonnet-4-6": 320_000 },
    };
  },
  async activity(limit) {
    return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      user: "alberto",
      verb: "created",
      target: `task-${i}`,
      product: "plyne-v3",
      kind: "task",
      t: new Date().toISOString(),
    }));
  },
};

/* ───── Spin up server + in-memory client ───── */
async function main() {
  // Server side
  const server = createPlyneMcpServer({ client: mock as never, logger: () => {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  // Client side
  const client = new Client(
    { name: "smoke-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientT);

  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`ASSERT FAIL — ${msg}`);
    process.stdout.write(`  ✓ ${msg}\n`);
  };

  process.stdout.write("== Plyne MCP smoke test ==\n\n");

  // 1. tools/list
  process.stdout.write("[1] tools/list\n");
  const tl = await client.listTools();
  assert(tl.tools.length === 5, `5 tools exposed (got ${tl.tools.length})`);
  const expected = ["plyne.task.create", "plyne.task.list", "plyne.task.get", "plyne.task.logs", "plyne.task.abort"];
  for (const e of expected) assert(tl.tools.some((t) => t.name === e), `tool present: ${e}`);

  // 2. resources/list
  process.stdout.write("\n[2] resources/list\n");
  const rl = await client.listResources();
  assert(rl.resources.length === 2, `2 static resources (got ${rl.resources.length})`);
  assert(rl.resources.some((r) => r.uri === "plyne://my-quota"), "plyne://my-quota present");
  assert(rl.resources.some((r) => r.uri === "plyne://team-activity"), "plyne://team-activity present");

  // 3. resources/templates/list
  process.stdout.write("\n[3] resources/templates/list\n");
  const rtl = await client.listResourceTemplates();
  assert(rtl.resourceTemplates.length === 1, "1 resource template");
  assert(
    rtl.resourceTemplates[0]!.uriTemplate === "plyne://tasks/{id}",
    "plyne://tasks/{id} template present",
  );

  // 4. tools/call: plyne.task.create
  process.stdout.write("\n[4] tools/call plyne.task.create\n");
  const createRes = await client.callTool({
    name: "plyne.task.create",
    arguments: {
      title: "[V3-TEST-HELLO-001] Smoke",
      product: "plyne-v3",
      instructions_md: "Smoke test scaffold to verify MCP wiring end-to-end.",
      acceptance_criteria: "tools/list returns 5\nresources/list returns 2",
      mcp_servers: ["github", "notion"],
      skills: ["github-pr-review"],
    },
  });
  const created = JSON.parse((createRes.content as Array<{ text: string }>)[0]!.text) as {
    ok: boolean;
    id: string;
    url: string;
    status: string;
  };
  assert(created.ok === true, "create ok:true");
  assert(created.id.startsWith("tsk_"), `task id returned: ${created.id}`);
  assert(created.status === "draft", "status=draft");

  // 5. tools/call: plyne.task.list
  process.stdout.write("\n[5] tools/call plyne.task.list\n");
  const listRes = await client.callTool({
    name: "plyne.task.list",
    arguments: { product: "plyne-v3" },
  });
  const listed = JSON.parse((listRes.content as Array<{ text: string }>)[0]!.text) as {
    ok: boolean;
    count: number;
    items: Array<{ id: string }>;
  };
  assert(listed.count === 1, `1 task listed (got ${listed.count})`);
  assert(listed.items[0]!.id === created.id, "listed task id matches created");

  // 6. tools/call: plyne.task.get
  process.stdout.write("\n[6] tools/call plyne.task.get\n");
  const getRes = await client.callTool({
    name: "plyne.task.get",
    arguments: { id: created.id },
  });
  const got = JSON.parse((getRes.content as Array<{ text: string }>)[0]!.text) as {
    ok: boolean;
    task: { mcp_servers: string[]; skills: string[]; model: string };
  };
  assert(got.task.mcp_servers.includes("github"), "mcp_servers persisted");
  assert(got.task.skills.includes("github-pr-review"), "skills persisted");
  assert(got.task.model === "claude-opus-4-8", "default model = opus-4-8");

  // 7. tools/call: plyne.task.logs
  process.stdout.write("\n[7] tools/call plyne.task.logs\n");
  const logsRes = await client.callTool({
    name: "plyne.task.logs",
    arguments: { id: created.id, limit: 50 },
  });
  const logs = JSON.parse((logsRes.content as Array<{ text: string }>)[0]!.text) as {
    ok: boolean;
    lines: Array<{ msg: string }>;
  };
  assert(logs.lines.length >= 1, `logs returned (${logs.lines.length} lines)`);

  // 8. resources/read plyne://tasks/{id}
  process.stdout.write("\n[8] resources/read plyne://tasks/{id}\n");
  const taskMd = await client.readResource({ uri: `plyne://tasks/${created.id}` });
  const text = (taskMd.contents[0]!.text as string) ?? "";
  assert(text.includes("# [V3-TEST-HELLO-001]"), "rendered title present");
  assert(text.includes("MCP servers: `github`, `notion`"), "stack rendered");
  assert(text.includes("github-pr-review"), "skills rendered");

  // 9. resources/read plyne://my-quota
  process.stdout.write("\n[9] resources/read plyne://my-quota\n");
  const quota = await client.readResource({ uri: "plyne://my-quota" });
  const quotaJson = JSON.parse(quota.contents[0]!.text as string) as { plan: string };
  assert(quotaJson.plan === "max-20x", "quota plan visible");

  // 10. resources/read plyne://team-activity
  process.stdout.write("\n[10] resources/read plyne://team-activity\n");
  const act = await client.readResource({ uri: "plyne://team-activity" });
  const events = JSON.parse(act.contents[0]!.text as string) as unknown[];
  assert(events.length >= 1, "activity returned");

  // 11. tools/call: plyne.task.abort
  process.stdout.write("\n[11] tools/call plyne.task.abort\n");
  const abortRes = await client.callTool({
    name: "plyne.task.abort",
    arguments: { id: created.id, reason: "smoke test cleanup" },
  });
  const aborted = JSON.parse((abortRes.content as Array<{ text: string }>)[0]!.text) as { ok: boolean };
  assert(aborted.ok === true, "abort ok");

  // 12. input validation
  process.stdout.write("\n[12] input validation\n");
  const bad = await client.callTool({
    name: "plyne.task.create",
    arguments: { title: "x" }, // missing required fields
  });
  assert(bad.isError === true, "invalid input → isError:true");

  await client.close();
  process.stdout.write("\n== SMOKE PASS — 12/12 ==\n");
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAIL: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
