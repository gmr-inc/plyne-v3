# Plyne v3 Skills library

Reusable Claude Skills playbooks loaded into the Claude Code subprocess context when
a Plyne v3 task declares them in its `skills: [...]` config.

## Inventory

| Skill | Purpose | MCP deps |
|---|---|---|
| `github-pr-review` | Standard PR review checklist + AC verification | github |
| `vercel-deploy-fixer` | Diagnose + fix Vercel deploy failures | vercel, github |
| `supabase-migration-applier` | Safe migration workflow (dry-run + backup + apply) | supabase |
| `nextjs-pixel-perfect` | Anthropic Design pack → Next.js handoff workflow | vercel, github |

## Format

Each skill is a directory with a `SKILL.md` containing:

1. **YAML frontmatter** with required keys:
   - `name` — kebab-case unique identifier
   - `description` — multi-line, used by the LLM to decide when to invoke
   - `usage` — when activation should occur
   - `trigger_intents` — array of natural-language phrases that should trigger this skill
   - `mcp_dependencies` — array of MCP server names this skill assumes are attached
   - `authors` — emails
   - `version` — semver
2. **Markdown body** — the actual playbook (phases, checklists, hard rules)

## How the stack-loader consumes this

The backend `src/executor/stack-loader.ts` (parallel sub-agent) reads task config:

```ts
type TaskStackConfig = {
  mcp_servers: string[];
  skills: string[];
  computer_use: boolean;
  model: "claude-opus-4-8" | "claude-sonnet-4-6" | "latest";
};
```

For each skill in `skills`, the loader:

1. Resolves `skills/<name>/SKILL.md` from this repo (vendored OR `git submodule`)
2. Verifies `mcp_dependencies` ⊆ `mcp_servers` — otherwise refuses to spawn
3. Appends the full `SKILL.md` body to the Claude Code system prompt under a
   `## Skills loaded` section, with the frontmatter stripped
4. Caches the prompt prefix via Anthropic prompt caching (see architecture doc §Prompt-caching)

## Adding a new skill

```bash
mkdir -p skills/<name>
$EDITOR skills/<name>/SKILL.md
# Update this README inventory table
# Open PR; the validator in CI checks frontmatter shape.
```

## Frontmatter linter (placeholder)

A minimal lint check (to be wired in CI):

```bash
node scripts/lint-skills.mjs  # checks every skills/*/SKILL.md has required frontmatter keys
```
