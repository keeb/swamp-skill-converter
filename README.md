# @keeb/skill-converter

Turn a Claude Code skill into swamp automation.

Point it at a `SKILL.md` (or a skill directory) and it:

1. **parses** the skill: frontmatter, body, reference files, the CLI tools its shell blocks call, and the hosts it touches;
2. **discovers** existing extensions on the swamp-club registry for those services, including their real model types, methods, and arguments;
3. **plans** the conversion with Claude. The plan lists which extensions to pull, which to extend, which new model types to scaffold, which vault secrets are needed, and the workflow DAG. Judgment steps become an LLM step or a `manual_approval` gate, deterministic checks become `assert` steps, and public actions are gated. The plan is validated against the catalog and swamp's workflow rules, and Claude is asked to repair it if needed;
4. **applies** it: writes `workflows/workflow-<name>.yaml`, writes TypeScript scaffolds for new or extended types (stub methods with implementation notes), optionally runs `swamp extension pull` for the planned packages, and runs `swamp workflow validate` on the result.

Claude is called through [`@keeb/anthropic`](https://swamp-club.com)'s `cli_generate_many`, i.e. your local `claude` CLI login. No API key is needed.

## Install

```bash
swamp extension pull @keeb/skill-converter   # also pulls @keeb/anthropic
```

Requires Claude Code (`claude`) installed and logged in on the host that runs `discover` and `plan`.

## Usage

The bundled workflow runs all four steps:

```bash
swamp workflow run @keeb/skill-to-swamp \
  --input skillPath=.claude/skills/nightly-db-backup \
  --input collective=acme \
  --input install=true
```

| Input          | Default           | Description                                              |
| -------------- | ----------------- | -------------------------------------------------------- |
| `skillPath`    | (required)        | `SKILL.md` file or skill directory                       |
| `collective`   | (required)        | Collective for scaffolded types (`@acme/postgres`)         |
| `converter`    | `skill-converter` | Instance name holding the skill, catalog, plan and output |
| `guidance`     | `""`              | Extra instructions for the planner                       |
| `extraQueries` | `[]`              | Additional registry search queries                       |
| `install`      | `false`           | Pull the planned extensions                              |
| `overwrite`    | `false`           | Replace existing scaffold files                          |

Or run the methods one at a time and inspect the data between steps:

```bash
swamp model create @keeb/skill-converter conv --global-arg collective=acme
swamp behavior run conv parse --input path=.claude/skills/nightly-db-backup
swamp behavior run conv discover
swamp behavior run conv plan --input guidance="Use GCS, not S3"
swamp behavior run conv apply --input install=true
swamp data query 'model("conv") && name == "conversion"' --select attributes.nextSteps
```

## Model: `@keeb/skill-converter`

**Global arguments:** `collective` (required), `llmModel` (`skill-converter-claude`, the `@keeb/anthropic/claude` instance it calls), `model` (`claude-opus-5-5`), `effort` (`high`), `timeoutSeconds` (`1800`), `registryUrl` (`https://swamp-club.com`).

| Method     | Arguments                                                                 | Writes                     |
| ---------- | ------------------------------------------------------------------------- | -------------------------- |
| `parse`    | `path`                                                                    | `skill`                    |
| `discover` | `extraQueries`, `useClaude` (true), `perQuery` (6), `maxExtensions` (16), `pinned` (`["@keeb/anthropic"]`) | `catalog` |
| `plan`     | `localTypes`, `guidance?`, `maxRepairs` (2)                               | `plan`                     |
| `apply`    | `workflowsDir`, `extensionsDir`, `overwrite`, `install`, `validate` (true) | `conversion`, `workflowYaml`, `scaffold` files |

`conversion` records what was written, skipped, and pulled, the `swamp workflow validate` result, and `nextSteps`: pull/trust commands, `swamp vault put` for each secret, stubs to implement, a report to build if the skill produces a summary, and the plan's open questions.

## What to expect

- The generated workflow is a starting point. Scaffolded methods throw until you implement them, and some open questions need a decision.
- Registry metadata is sometimes incomplete; some packages don't publish method arguments. `plan` can't see those, so `apply` runs `swamp workflow validate` with the real installed types and reports anything missing (e.g. `Missing required inputs: <arg>`).
- `install` pulls packages from any collective. Review non-`@swamp` packages before trusting or running them; `nextSteps` lists the `swamp extension trust add` commands.
- Planning is non-deterministic. Re-running `plan` can choose a different split (e.g. extend an existing LLM type vs. scaffold a new one). Use `guidance` to pin decisions.

## License

MIT
