# plyne-v3

> Thin Claude Code orchestrator that ABUSES the Anthropic stack: MCP servers, Claude Skills, sub-agents, memory, hooks, extended thinking, prompt caching, batch API.

Replacement of `cto-v2`. NOT autonomous CTO — it's the operator's "spawn Claude Code with the right stack loaded" daemon.

## Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). One-line summary:

```
Operator writes concrete AC → Plyne v3 polls Notion → claims task →
spawns `claude` CLI with MCP + Skills + Memory + Hooks from task config →
monitors → updates Notion → operator merges PR (manual gate).
```

## Model

- Default: `claude-opus-4-8` with extended thinking on M/L/XL tasks.
- Override per task via `model` config field.
- NO `claude-opus-4-7` references (legacy, deprecated).

## Local dev

```bash
npm install
cp .env.example .env  # fill ANTHROPIC_API_KEY, NOTION_TOKEN, etc.
npm run dev
```

## Deploy (VPS Hetzner)

```bash
ssh plyne@128.140.125.58
cd ~/Desktop/Projects/plyne-v3
git pull
npm install
npm run build
pm2 restart plyne-v3 || pm2 start dist/index.js --name plyne-v3
```

Runs parallel to `cto-v2` (v2 legacy). Same VPS, different pm2 process.

## Smoke test

```bash
npm run smoke
# Spawns Claude on a [V3-TEST-HELLO-001] task → writes file → exits.
```
