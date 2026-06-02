# Plyne v3 Skills library

Reusable Claude Skills playbooks loaded into the Claude Code subprocess context when
a Plyne v3 task declares them in its `skills: [...]` config.

## Inventory

| Skill | Purpose | MCP deps |
|---|---|---|
| `github-pr-review` | Standard PR review checklist + AC verification | github |
| `vercel-deploy-fixer` | Diagnose + fix Vercel deploy failures | vercel, github |
| `supabase-migration-applier` | Safe migration workflow (dry-run + backup + apply) | supabase |
| `nextjs-pixel-perfect` | Anthropic Design pack -> Next.js handoff workflow | vercel, github |

## Format

Each skill is a directory with a `SKILL.md` containing:

1. **YAML frontmatter** with required keys:
   - `name` — kebab-case unique identifier
   - `description` — multi-line, used by the LLM to decide when to invoke
   - `usage` — when activation should occur
   - `mcp_dependencies` — array of MCP server names this skill assumes are attached
   - `version` — semver
2. **Markdown body** — the actual playbook (phases, checklists, hard rules)

## Adding a new skill

```bash
mkdir -p skills/<name>
$EDITOR skills/<name>/SKILL.md
# Update this README inventory table
```
