# plyne-v3 — guidance for Claude Code

When working inside this repo:

1. Read `docs/ARCHITECTURE.md` BEFORE editing — pivot from v2 is non-trivial.
2. Model is `claude-opus-4-8`. No `claude-opus-4-7` references anywhere.
3. The orchestrator is intentionally thin. Resist the urge to re-add v2
   subsystems (spec-validator, decomposer, merge-loop, sprint-planner…).
4. Code review + spec validation are delegated to Claude's native sub-agents
   (Explore / Plan / code-reviewer). DO NOT reintroduce custom equivalents.
5. Status state machine is just: `ready → claiming → executing → done |
   needs-operator`. Do not add intermediate states without an architecture
   update.
6. Plyne v3 NEVER merges PRs. Always defer the merge to the operator.

## Trigger-word lint
Don't use "autonomous CTO", "self-improving", "decomposer", "spec-guardian"
in copy — they belong to v2 and are misleading for v3.
