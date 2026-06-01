# Plyne v3

Thin Claude Code orchestrator that **abuses the Anthropic stack** (MCP servers, Skills, Sub-agents, Hooks, Memory, Computer Use).
See `/tmp/plyne-v3-architecture.md` (single source of truth, authored 2026-06-01 by Alberto Nasciuti).

This sub-tree currently ships:

- **`src/mcp/`** — real MCP server (5 tools + 3 resources) wired to the Plyne v3 REST API
- **`skills/`** — initial Claude Skills library (4 playbooks)

The backend (`src/executor/`, `src/orchestrator/`, `src/api/`, `src/supabase/`) is scaffolded by the parallel sub-agent — this README will be merged with theirs.

---

## MCP server

### Tools exposed (5)

| Tool | Purpose | REST mapping |
|---|---|---|
| `plyne.task.create` | Create a task with MCP/Skills/Computer-Use/model config | `POST /v1/tasks` |
| `plyne.task.list` | List tasks with filters | `GET /v1/tasks` |
| `plyne.task.get` | Full task detail (instructions + AC + stack + cost) | `GET /v1/tasks/:id` |
| `plyne.task.logs` | Paginated logs (follow=true → tailing) | `GET /v1/tasks/:id/logs` |
| `plyne.task.abort` | Abort a running task | `DELETE /v1/tasks/:id` |

### Resources exposed (3)

| URI | MIME | What |
|---|---|---|
| `plyne://tasks/{id}` | `text/markdown` | Rendered task detail |
| `plyne://my-quota` | `application/json` | Current user quota + per-model breakdown |
| `plyne://team-activity` | `application/json` | Last 50 cross-team events |

### Auth

Two modes, resolved in this order:

1. **Personal Access Token (dev / CI)** — `PLYNE_PAT=<token>` env var
2. **OAuth JWT (prod)** — populated by `plyne-cli auth login` into `~/.claude/mcp-credentials/plyne.json`

If neither is present the server refuses to start. The OAuth backend wiring is owned by the backend sub-agent (`src/api/routes/auth.ts`); until it ships, PAT is the supported path.

### Transports

- **stdio** (default) — `pnpm mcp:stdio` then in another shell:
  ```bash
  claude mcp add plyne --transport stdio --command "tsx $(pwd)/src/mcp/server.ts" --env PLYNE_PAT=$PLYNE_PAT
  ```
- **streamable HTTP** — `PLYNE_MCP_TRANSPORT=http PORT=8787 pnpm mcp:http`, then:
  ```bash
  # Local development
  claude mcp add plyne --url http://localhost:8787/mcp
  # Production (once DNS ready):
  claude mcp add plyne --url https://plyne.dev/mcp
  ```

Health endpoint (HTTP mode only): `GET /mcp/health` → `{"ok":true,"name":"plyne","version":"0.1.0"}`.

### Smoke test

A self-contained in-memory test exercises tools, resources, and validation without
needing the backend live:

```bash
PLYNE_PAT=dev pnpm mcp:smoke
# == SMOKE PASS — 12/12 ==
```

Covers: `tools/list` (5), `resources/list` (2), `resources/templates/list` (1),
`tools/call` for all 5 tools, `resources/read` for all 3 resource types, and Zod input
validation rejection.

---

## Skills library

See [`skills/README.md`](skills/README.md). Inventory:

- `github-pr-review` — standard PR review checklist
- `vercel-deploy-fixer` — diagnose + fix Vercel deploy failures
- `supabase-migration-applier` — safe migration workflow (dry-run + backup + apply)
- `nextjs-pixel-perfect` — Anthropic Design pack → Next.js handoff

Each is a `skills/<name>/SKILL.md` file with YAML frontmatter (name/description/usage/trigger_intents/mcp_dependencies/version) + markdown body.

The backend `src/executor/stack-loader.ts` consumes these when a task config
declares `skills: ["..."]`.

---

## Local dev quickstart

```bash
npm install
PLYNE_PAT=dev npm run mcp:smoke   # 12/12 in ~3s
PLYNE_PAT=dev npm run mcp:http    # http://localhost:8787/mcp
```

---

## Files in this sub-tree

```
src/mcp/
├── server.ts          # MCP server (real, no stub) — stdio + streamable HTTP
└── client.ts          # PlyneHttpClient + Zod schemas + auth resolution

skills/
├── README.md
├── github-pr-review/SKILL.md
├── vercel-deploy-fixer/SKILL.md
├── supabase-migration-applier/SKILL.md
└── nextjs-pixel-perfect/SKILL.md

scripts/
└── smoke-test.ts       # in-memory smoke (12/12 PASS)
```
