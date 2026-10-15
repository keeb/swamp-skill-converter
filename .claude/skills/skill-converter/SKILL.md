---
name: skill-converter
description: Use the @keeb/skill-converter swamp extension to turn a Claude Code skill (a SKILL.md plus references) into swamp automation — a workflow, scaffolds for missing extension models, and the extensions to pull. Use when asked to convert, port, or automate a skill as a swamp workflow, to turn a hand-run agent procedure into a workflow, to run the `@keeb/skill-to-swamp` workflow, or to work with the `@keeb/skill-converter` model's parse / discover / plan / apply methods and their skill, catalog, plan and conversion data. Triggers on "convert skill", "skill to swamp", "skill to workflow", "automate this skill", "SKILL.md to workflow", "@keeb/skill-converter", "skill-to-swamp".
---

# @keeb/skill-converter

Converts a Claude Code skill into swamp automation, grounded in what already
exists on the swamp-club registry. Claude is called through
`@keeb/anthropic/claude`'s `cli_generate_many`, so the host needs Claude Code
installed and logged in (no API key).

## Fastest path

```bash
swamp extension pull @keeb/skill-converter
swamp workflow run @keeb/skill-to-swamp \
  --input skillPath=.claude/skills/<skill> \
  --input collective=<your-collective> \
  --input install=true
swamp data query 'model("skill-converter") && name == "conversion"' --select attributes
```

Then work through `conversion.nextSteps` in order and re-run
`swamp workflow validate <name> --json` until it passes.

## Methods (one model instance, run in order)

| Method     | Reads             | Writes                                         | Notes                                                                           |
| ---------- | ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `parse`    | the skill on disk | `skill`                                        | `path` = SKILL.md or skill dir; other `.md` files are references                |
| `discover` | `skill`           | `catalog`                                      | registry search; `extraQueries`, `pinned` (default `@keeb/anthropic`)           |
| `plan`     | `skill`,`catalog` | `plan`                                         | Claude plan + validation + up to `maxRepairs` fixes; `guidance` steers it       |
| `apply`    | `plan`            | `conversion`, `workflowYaml`, `scaffold` files | writes files; `install` pulls; `validate` runs `swamp workflow validate`        |

Global arguments: `collective` (required), `llmModel`, `model`
(`claude-opus-5-5`), `effort` (`high`), `timeoutSeconds`, `registryUrl`.

## Reading the results

```bash
# What the plan decided
swamp data query 'model("skill-converter") && name == "plan"' \
  --select '{"summary": attributes.summary, "rationale": attributes.plan.rationale, "open": attributes.plan.openQuestions}'

# What apply did, and what is left
swamp data query 'model("skill-converter") && name == "conversion"' \
  --select '{"validation": attributes.validation, "next": attributes.nextSteps}'
```

## Steering the plan

- Re-run only `plan` (then `apply`) with `--input guidance="..."` to pin
  decisions: "extend @keeb/anthropic for the summary step", "GCS, not S3",
  "no manual approvals".
- If discovery missed a service, re-run `discover` with
  `--input 'extraQueries:json=["jira"]'`, then `plan` again.
- Pass types already installed in the repo via
  `--input 'localTypes:json=["@acme/thing"]'` so the plan can use them.

## Gotchas

- **Plans are non-deterministic.** Two runs can split the work differently.
  Read `plan.rationale` before applying.
- **Registry metadata can be incomplete** (some packages publish methods without
  arguments). `apply` runs `swamp workflow validate` with the real installed
  types and records failures in `conversion.validation` — fix those inputs by
  hand.
- **Scaffolds are stubs.** Every scaffolded method throws until implemented;
  the implementation notes are in comments.
- **`install` pulls from any collective.** Review non-`@swamp` packages before
  `swamp extension trust add`.
- **Re-applying** keeps the workflow id and skips existing scaffolds unless
  `overwrite=true`.
