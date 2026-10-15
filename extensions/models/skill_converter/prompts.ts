/**
 * System prompts and message builders for the converter's Claude calls.
 *
 * @module
 */
import type { ParsedSkill } from "./skill.ts";
import type { CatalogExtension } from "./registry.ts";

/** System prompt for extracting registry search terms from a skill. */
export const DISCOVERY_SYSTEM =
  `You read Claude Code skills (SKILL.md files that teach an agent a repeatable procedure) and list what external systems the procedure touches, so a registry of automation extensions can be searched.

Return:
- services: every external service, platform, API, or CLI the procedure reads from or acts on (clouds, databases, storage, chat tools, ticketing, LLM providers). Lowercase, one word where possible.
- queries: 3-12 short search queries for an extension registry that is organized by service name, not by operation. Prefer the service name ("postgres", not "dump a database"). Add capability queries only for things with no obvious service (e.g. "claude" or "llm" when a step needs judgment; "markdown" or "report" when it produces a document).`;

/** System prompt for producing the conversion plan. */
export const PLAN_SYSTEM =
  `You convert Claude Code skills into swamp automation. A skill is a markdown procedure an agent follows step by step; your job is to turn the repeatable parts into a swamp workflow and say exactly which extensions to install or build.

## swamp in brief
- Model types are typed integrations (e.g. "@swamp/github") with methods. A model instance is a named configuration of a type (global arguments). Methods write versioned data.
- Workflows are YAML DAGs: jobs (which can depend on other jobs) contain steps (which can depend on earlier steps in the same job). Step kinds you may use:
  - model_method: call modelType.methodName on instance modelName with globalArgs and inputs. Steps that share a modelName share that instance's data.
  - manual_approval: suspend until a human approves; use for judgment calls the procedure leaves to a person.
  - assert: a CEL predicate over earlier data that must hold.
- Data written by an earlier step is read with CEL: \${{ data.latest("<modelName>", "<dataName>").attributes.<field> }}. Use the null-safe form \${{ data.latest("m", "d").?attributes.?field.orValue("") }} when the data is written earlier in the same run. Never use the deprecated model.<name>.resource... form.
- Workflow inputs are referenced as \${{ inputs.<name> }}. Inputs are recorded in plaintext, so never make a secret an input.
- Secrets come from vaults: a global argument value of \${{ vault.get(<vault>, <KEY>) }}. Declare each in vaultSecrets.
- guard: a CEL expression; when truthy the step is skipped. Use guards to make re-runs idempotent.

## Rules (follow strictly)
1. Search before you build. Prefer extensions from the provided catalog, official @swamp/* first. Only list a package in extensionsToPull if it is in the catalog, and only list types and method names that the catalog shows for it. If a catalog type's method list is empty, its metadata is incomplete; you may use it but say so in openQuestions.
2. Extend, don't be clever. If a catalog type covers the service but lacks the method you need, put it in extensionsToExtend (that type must also be in extensionsToPull) rather than creating a parallel type.
3. Create a new type in extensionsToCreate only when nothing in the catalog covers the service. One type per service, named @<collective>/<service>. Methods are camelCase, one purpose each, and the implementation notes name the concrete API endpoints or CLI invocations.
4. command/shell is only for genuine one-off commands, never for wrapping a CLI or API integration. If the skill shells out to a CLI (aws, kubectl, psql, terraform...), that becomes a typed model method.
5. Prefer fan-out methods: one method that handles a list of targets rather than a forEach of identical calls.
6. Parts of the procedure that need reasoning (interpreting free-form text, writing prose or code, making a judgment call) are not deterministic. Map them to an LLM model type from the catalog (e.g. a Claude/Anthropic or Claude Code extension) when one fits; otherwise create a method whose notes say it calls an LLM, or gate the step with manual_approval. Say which in rationale.
7. Steps the skill expects a human to confirm (deploy, delete, post publicly) get a manual_approval step before them.
8. Deterministic checks the skill describes ("the listing is non-empty", "the command exits 0") become assert steps over the data the previous step wrote.
9. Use workflow inputs for everything that varies per run (target names, identifiers, environment). Keep the workflow general; don't hardcode values from the skill's examples.
10. Names: workflow, jobs, steps and modelName are kebab-case. Step dependsOn may only name steps in the same job; cross-job ordering uses job dependsOn.
11. Plan value fields (globalArgs/inputs values, input defaults) are JSON-encoded: "\\"main\\"", "3", "true". A swamp expression is written bare: \${{ inputs.repo }}.
12. If the skill's output is a summary or analysis of what the run produced, set report.needed and describe the report.
13. Put anything you had to assume, and anything the user must decide, in openQuestions. Do not invent catalog entries.`;

function renderCatalog(catalog: CatalogExtension[]): string {
  if (!catalog.length) {
    return "(no matching extensions were found in the registry)";
  }
  return catalog.map((e) => {
    const head = `### ${e.name}${
      e.official ? " (official)" : ""
    } v${e.latestVersion} — pulls: ${e.pullCount}${
      e.scoreGrade ? `, grade ${e.scoreGrade}` : ""
    }\n${e.description}`;
    const types = e.types.map((t) => {
      const globals = t.globalArguments.map((a) =>
        `${a.name}${a.required ? "" : "?"}: ${a.type}`
      ).join(", ");
      const methods = t.methods.length
        ? t.methods.map((m) =>
          `  - ${m.name}(${
            m.arguments.map((a) =>
              `${a.name}${a.required ? "" : "?"}: ${a.type}`
            ).join(", ")
          })${m.description ? ` — ${m.description}` : ""}`
        ).join("\n")
        : "  - (method list not published)";
      return `- type ${t.type} [globals: ${globals || "none"}]\n${methods}`;
    }).join("\n");
    const wfs = e.workflows.length
      ? `\nworkflows: ${e.workflows.join(", ")}`
      : "";
    return `${head}\n${types || "- (no model types published)"}${wfs}`;
  }).join("\n\n");
}

function renderSkill(skill: ParsedSkill): string {
  const refs = skill.references.map((r) =>
    `<reference path="${r.path}">\n${r.content}\n</reference>`
  ).join("\n");
  const fm = Object.keys(skill.frontmatter).length
    ? `\nOther frontmatter: ${JSON.stringify(skill.frontmatter)}`
    : "";
  return `<skill name="${skill.name}">
Description: ${skill.description}${fm}
Detected CLI tools: ${skill.cliTools.join(", ") || "none"}
Referenced hosts: ${skill.hosts.join(", ") || "none"}
Bundled non-markdown files: ${skill.assets.join(", ") || "none"}

<skill_md>
${skill.body}
</skill_md>
${refs}
</skill>`;
}

/** User message for discovery. */
export function discoveryMessage(skill: ParsedSkill): string {
  return `${
    renderSkill(skill)
  }\n\nList the services and registry search queries for this skill.`;
}

/** User message for planning. */
export function planMessage(
  skill: ParsedSkill,
  catalog: CatalogExtension[],
  opts: {
    collective: string;
    localTypes: string[];
    guidance: string | undefined;
  },
): string {
  const local = opts.localTypes.length
    ? opts.localTypes.join(", ")
    : "none listed";
  const guidance = opts.guidance
    ? `\n\n<operator_guidance>\n${opts.guidance}\n</operator_guidance>`
    : "";
  return `${renderSkill(skill)}

<catalog>
${renderCatalog(catalog)}
</catalog>

Collective for new types: @${opts.collective}
Model types already installed in the target repo: ${local}${guidance}

Produce the conversion plan.`;
}

/** Appended to the plan prompt when a previous plan failed validation. */
export function repairMessage(previous: unknown, errors: string[]): string {
  return `<previous_plan>\n${
    JSON.stringify(previous, null, 2)
  }\n</previous_plan>\n\n` +
    `That plan failed validation. Fix every problem below and return the complete corrected plan.\n\n` +
    errors.map((e) => `- ${e}`).join("\n");
}
