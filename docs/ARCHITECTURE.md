# Plyne v3 — Architecture

> Mirrored from `/tmp/plyne-v3-architecture.md` (Alberto, 2026-06-01).
> Kept in-repo as the source of truth all sub-agents must read before coding.

## TL;DR

Plyne v3 is **NOT** an autonomous CTO. It is a thin Claude Code orchestrator
that ABUSES the Anthropic stack:

```
Operator writes concrete AC
            ↓
Plyne v3 polls Notion → picks `ready` task tagged V3-TEST-*
            ↓
Plyne v3 spawns `claude` CLI with:
   - MCP servers (GitHub, Notion, Vercel, Supabase, Slack — per task config)
   - Claude Skills (per task config)
   - Memory (product-scoped)
   - Sub-agents (Explore / Plan / code-reviewer — Claude's native ones)
   - Extended thinking on M/L/XL
   - Computer Use (opt-in for UI tasks)
            ↓
Claude does the work end-to-end using native Anthropic capabilities
            ↓
Plyne v3 reads PLYNE_V3_DONE.txt / PLYNE_V3_BLOCKED.txt marker → updates
Notion status → posts a comment summarising the run.
            ↓
Operator reviews the PR Claude opened → merges manually (NEVER auto-merge).
```

## Differences vs cto-v2

| cto-v2 (v2) | plyne-v3 |
|---|---|
| Autonomous-CTO illusion | Thin orchestrator |
| Custom spec-validator + spec-guardian + decomposer + supervisor + output-validator | REMOVED — replaced by MCP/Skills/Sub-agents |
| Plyne brain enriches the spec | Operator writes concrete AC upfront |
| Auto-merge loop | Operator merges manually (UI 1-click) |
| Self-improvement PL-CTO loops | REMOVED |
| ~50k LoC custom logic | ~1.5k LoC orchestrator + relies on Claude stack |

## Model

- Default: `claude-opus-4-8` with extended thinking on M/L/XL tasks.
- `PLYNE_CLAUDE_MODEL` env can override.
- Per-task override via the `Model` Notion select property.
- Zero `claude-opus-4-7` references (legacy, deprecated).

## Source layout

```
src/
  config/        env + logger
  notion/        minimal task R/W gateway
  executor/
    worktree.ts          per-task sandbox dir
    stack-loader.ts      MCP + Skills + model → CLI args
    claude-cli-executor.ts  spawn `claude` + capture result
  orchestrator/
    runner.ts            singolo cycle: poll → claim → execute → update
  mcp/
    server.ts            Plyne v3 EXPOSES MCP tools (task.list/get/abort)
  api/
    server.ts            health + MCP endpoint
  smoke/
    v3-test-hello.ts     synthetic V3-TEST-HELLO-001 smoke
  index.ts               boot
```

## Status state machine

`ready` → `claiming` → `executing` → `done` | `needs-operator`

No more `decomposing` / `validating` / `merging` / `pr-open` / `abandoned` —
the operator-facing taxonomy collapses to "Claude is on it" vs "human attention".

## What v3 does NOT do (intentionally)

- Decompose tasks (operator writes them)
- Validate specs (Claude's planning sub-agent handles edge cases)
- Run output-validation (Claude's code-reviewer sub-agent / CI does)
- Merge PRs (operator manual gate)
- Self-promote tasks (operator promotes backlog → ready)
- Heal "stale" tasks (operator unsticks via the MCP `task.abort` tool)
