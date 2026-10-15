/**
 * Swamp extension model @keeb/skill-converter.
 *
 * Converts a Claude Code skill (SKILL.md + references) into swamp
 * automation: it finds existing extensions in the swamp-club registry that
 * cover the services the skill touches, asks Claude (via the
 * `@keeb/anthropic/claude` model's local `claude` CLI method) for a
 * conversion plan grounded in those real types and methods, then writes a workflow YAML,
 * scaffolds any extension models that don't exist yet, and optionally pulls
 * the extensions the workflow needs.
 *
 * Methods run in order — parse → discover → plan → apply — and each reads
 * the previous one's data, so the bundled `skill-to-swamp` workflow (or four
 * method runs against one model instance) does the whole conversion.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import { readSkill, SHELL_NOISE } from "./skill_converter/skill.ts";
import type { ParsedSkill } from "./skill_converter/skill.ts";
import { buildCatalog } from "./skill_converter/registry.ts";
import type { CatalogExtension } from "./skill_converter/registry.ts";
import {
  calver,
  ConversionPlanSchema,
  DiscoveryTermsSchema,
  renderExtensionScaffold,
  renderModelScaffold,
  renderWorkflowYaml,
  validatePlan,
} from "./skill_converter/plan.ts";
import type { ConversionPlan, PlanIssues } from "./skill_converter/plan.ts";
import { callStructured } from "./skill_converter/llm.ts";
import type { LlmContext } from "./skill_converter/llm.ts";
import {
  DISCOVERY_SYSTEM,
  discoveryMessage,
  PLAN_SYSTEM,
  planMessage,
  repairMessage,
} from "./skill_converter/prompts.ts";

const GlobalArgsSchema = z.object({
  llmModel: z.string().default("skill-converter-claude").describe(
    "Name of the @keeb/anthropic/claude instance that discover and plan call (created on first use)",
  ),
  collective: z.string().regex(/^[a-z0-9_-]+$/).describe(
    "Collective that newly scaffolded model types are created under (e.g. 'acme' → @acme/postgres)",
  ),
  model: z.string().default("claude-opus-5-5").describe(
    "Claude model ID used for discovery and planning",
  ),
  timeoutSeconds: z.number().default(1800).describe(
    "Seconds each Claude call may take (1-7200)",
  ),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high")
    .describe(
      "Claude effort level for planning (discovery always runs at low)",
    ),
  registryUrl: z.string().url().default("https://swamp-club.com").describe(
    "swamp-club registry base URL",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CatalogArgSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  description: z.string(),
});

const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  headings: z.array(z.string()),
  codeBlocks: z.array(z.object({ lang: z.string(), code: z.string() })),
  cliTools: z.array(z.string()),
  hosts: z.array(z.string()),
  references: z.array(z.object({ path: z.string(), content: z.string() })),
  assets: z.array(z.string()),
  sourcePath: z.string(),
  contentHash: z.string(),
});

const CatalogSchema = z.object({
  skillHash: z.string(),
  services: z.array(z.string()),
  queries: z.array(z.string()),
  failedQueries: z.array(z.string()),
  truncated: z.boolean().describe(
    "True when more matching extensions existed than maxExtensions allowed",
  ),
  extensions: z.array(z.object({
    name: z.string(),
    description: z.string(),
    latestVersion: z.string(),
    official: z.boolean(),
    pullCount: z.number(),
    scoreGrade: z.string().nullable(),
    matchedQueries: z.array(z.string()),
    types: z.array(z.object({
      type: z.string(),
      globalArguments: z.array(CatalogArgSchema),
      methods: z.array(z.object({
        name: z.string(),
        description: z.string(),
        arguments: z.array(CatalogArgSchema),
      })),
    })),
    workflows: z.array(z.string()),
  })),
  timestamp: z.string(),
});

const PlanResourceSchema = z.object({
  skillName: z.string(),
  skillHash: z.string(),
  workflowName: z.string(),
  automatable: z.enum(["full", "partial", "none"]),
  summary: z.string(),
  plan: ConversionPlanSchema,
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  repairRounds: z.number(),
  model: z.string(),
  timestamp: z.string(),
});

const ConversionSchema = z.object({
  skillName: z.string(),
  workflowName: z.string(),
  workflowPath: z.string(),
  scaffolded: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  pullCommands: z.array(z.string()),
  pulled: z.array(
    z.object({ package: z.string(), ok: z.boolean(), output: z.string() }),
  ),
  validation: z.object({
    ran: z.boolean(),
    passed: z.boolean(),
    failures: z.array(z.string()),
  }).describe("Result of `swamp workflow validate` on the written workflow"),
  vaultSecrets: z.array(
    z.object({ vault: z.string(), key: z.string(), purpose: z.string() }),
  ),
  nextSteps: z.array(z.string()),
  warnings: z.array(z.string()),
  timestamp: z.string(),
});

type SkillData = z.infer<typeof SkillSchema>;
type CatalogData = z.infer<typeof CatalogSchema>;
type PlanData = z.infer<typeof PlanResourceSchema>;

interface Logger {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
}

interface DataHandle {
  name: string;
}

interface FileWriter {
  writeText: (text: string) => Promise<DataHandle>;
}

interface Ctx extends LlmContext {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: Logger;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (spec: string, name: string) => FileWriter;
}

async function readRequired<T>(
  ctx: Ctx,
  name: string,
  previous: string,
): Promise<T> {
  const data = await ctx.readResource!(name);
  if (!data) {
    throw new Error(
      `No ${name} data on this model yet; run '${previous}' first.`,
    );
  }
  return data as T;
}

/** Rejects non-integers and out-of-range values with an error naming the argument. */
function intInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer from ${min} to ${max}, got ${value}.`,
    );
  }
  return value;
}

function llmOpts(
  ctx: Ctx,
): { llmModel: string; model: string; timeoutSeconds: number } {
  return {
    llmModel: ctx.globalArgs.llmModel,
    model: ctx.globalArgs.model,
    timeoutSeconds: intInRange(
      "timeoutSeconds",
      ctx.globalArgs.timeoutSeconds,
      1,
      7200,
    ),
  };
}

/**
 * Runs a swamp CLI command against this repo. Only apply uses this, for the
 * two operations no context API covers: installing extensions and validating
 * the workflow file it just wrote.
 */
async function runSwamp(
  ctx: Ctx,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  // swamp-quality-ignore deno-command: extension pull and workflow validate have no context API; args are fixed verbs plus a catalog package name or a kebab-case workflow name checked by validatePlan
  const out = await new Deno.Command("swamp", {
    args: [...args, "--repo-dir", ctx.repoDir],
    cwd: ctx.repoDir,
    stdout: "piped",
    stderr: "piped",
    signal: ctx.signal,
  }).output();
  const dec = new TextDecoder();
  return {
    success: out.success,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

function resolvePath(repoDir: string, p: string): string {
  return p.startsWith("/") ? p : `${repoDir}/${p}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Reuses the id of an existing workflow file so re-applying updates it in place. */
async function existingWorkflowId(path: string): Promise<string | null> {
  if (!await exists(path)) return null;
  const doc = parseYaml(await Deno.readTextFile(path)) as
    | { id?: unknown }
    | null;
  return typeof doc?.id === "string" ? doc.id : null;
}

/** Swamp extension model definition for converting Claude Code skills into swamp workflows and extensions. */
export const model = {
  type: "@keeb/skill-converter",
  version: "2026.10.15.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.15.2",
      description: "Prompt and documentation wording; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    skill: {
      description:
        "Parsed skill: frontmatter, body, references, detected CLI tools and hosts",
      schema: SkillSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    catalog: {
      description:
        "Registry extensions (with types, methods and arguments) relevant to the skill",
      schema: CatalogSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    plan: {
      description:
        "Validated conversion plan: extensions to pull/create/extend, vault secrets, workflow",
      schema: PlanResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    conversion: {
      description:
        "What apply wrote to the repo, what it pulled, and what is left to do",
      schema: ConversionSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    workflowYaml: {
      description: "Generated workflow YAML",
      contentType: "application/yaml",
      lifetime: "infinite",
      garbageCollection: 20,
    },
    scaffold: {
      description: "Generated extension model scaffold (TypeScript)",
      contentType: "text/typescript",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    parse: {
      description:
        "Read a skill (SKILL.md file or skill directory) and extract its structure",
      arguments: z.object({
        path: z.string().describe(
          "Path to a SKILL.md file or a skill directory, absolute or relative to the repo",
        ),
      }),
      execute: async (
        args: { path: string },
        ctx: Ctx,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const skill: ParsedSkill = await readSkill(
          resolvePath(ctx.repoDir, args.path),
        );
        ctx.logger.info(
          "Parsed skill {name}: {refs} reference files, CLI tools: {tools}",
          {
            name: skill.name,
            refs: skill.references.length,
            tools: skill.cliTools.join(", ") || "none",
          },
        );
        const handle = await ctx.writeResource("skill", "skill", { ...skill });
        return { dataHandles: [handle] };
      },
    },

    discover: {
      description:
        "Search the swamp-club registry for extensions covering the services the skill uses",
      arguments: z.object({
        extraQueries: z.array(z.string()).default([]).describe(
          "Additional registry search queries",
        ),
        useClaude: z.boolean().default(true).describe(
          "Ask Claude for service names and queries; when false, only detected CLI tools and extraQueries are searched",
        ),
        perQuery: z.number().default(6).describe(
          "Registry hits kept per query (1-25)",
        ),
        pinned: z.array(z.string()).default(["@keeb/anthropic"]).describe(
          "Extensions always included in the catalog regardless of search results (e.g. the LLM integration to use for judgment steps)",
        ),
        maxExtensions: z.number().default(16).describe(
          "Extensions hydrated with type metadata for planning (1-40)",
        ),
      }),
      execute: async (
        args: {
          extraQueries: string[];
          useClaude: boolean;
          perQuery: number;
          pinned: string[];
          maxExtensions: number;
        },
        ctx: Ctx,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const skill = await readRequired<SkillData>(ctx, "skill", "parse");
        let services: string[] = [];
        let queries: string[] = [...skill.cliTools];
        if (args.useClaude) {
          const terms = await callStructured(ctx, {
            ...llmOpts(ctx),
            key: "discover",
            effort: "low",
            system: DISCOVERY_SYSTEM,
            prompt: discoveryMessage(skill as ParsedSkill),
            schema: DiscoveryTermsSchema,
          });
          services = terms.services;
          queries.push(...terms.services, ...terms.queries);
        }
        queries.push(...args.extraQueries);
        queries = [
          ...new Set(
            queries.map((q) => q.trim().toLowerCase()).filter((q) =>
              q && !SHELL_NOISE.has(q)
            ),
          ),
        ];
        services = services.filter((s) => !SHELL_NOISE.has(s.toLowerCase()));
        if (!queries.length) {
          throw new Error(
            "No search queries: the skill has no detectable CLI tools. Pass extraQueries or enable useClaude.",
          );
        }

        const { extensions, failedQueries, truncated } = await buildCatalog(
          ctx.globalArgs.registryUrl,
          queries,
          {
            perQuery: intInRange("perQuery", args.perQuery, 1, 25),
            maxExtensions: intInRange(
              "maxExtensions",
              args.maxExtensions,
              1,
              40,
            ),
            pinned: args.pinned,
            signal: ctx.signal,
          },
        );
        if (failedQueries.length) {
          ctx.logger.warning("Registry search failed for: {queries}", {
            queries: failedQueries.join(", "),
          });
        }
        ctx.logger.info(
          "Found {n} candidate extensions for {q} queries{more}",
          {
            n: extensions.length,
            q: queries.length,
            more: truncated
              ? " (more matched; raise maxExtensions to see them)"
              : "",
          },
        );
        const handle = await ctx.writeResource("catalog", "catalog", {
          skillHash: skill.contentHash,
          services,
          queries,
          failedQueries,
          truncated,
          extensions,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Ask Claude for a conversion plan grounded in the discovered catalog, and validate it",
      arguments: z.object({
        localTypes: z.array(z.string()).default([]).describe(
          "Model types already installed in the target repo that the plan may use (from `swamp model type search --json`)",
        ),
        guidance: z.string().optional().describe(
          "Extra instructions for the conversion (scope, naming, constraints)",
        ),
        maxRepairs: z.number().default(2).describe(
          "Times Claude may revise a plan that fails validation (0-3)",
        ),
      }),
      execute: async (
        args: { localTypes: string[]; guidance?: string; maxRepairs: number },
        ctx: Ctx,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const maxRepairs = intInRange("maxRepairs", args.maxRepairs, 0, 3);
        const skill = await readRequired<SkillData>(ctx, "skill", "parse");
        const catalog = await readRequired<CatalogData>(
          ctx,
          "catalog",
          "discover",
        );
        if (catalog.skillHash !== skill.contentHash) {
          throw new Error(
            "The catalog was built for a different version of the skill; re-run 'discover'.",
          );
        }
        const exts = catalog.extensions as CatalogExtension[];
        const opts = {
          collective: ctx.globalArgs.collective,
          localTypes: args.localTypes,
        };
        const basePrompt = planMessage(skill as ParsedSkill, exts, {
          ...opts,
          guidance: args.guidance,
        });

        let plan: ConversionPlan | null = null;
        let issues: PlanIssues = { errors: [], warnings: [] };
        let rounds = 0;
        for (;; rounds++) {
          // Each round is a fresh CLI call; a repair round carries the rejected plan and its errors.
          const prompt = plan
            ? `${basePrompt}\n\n${repairMessage(plan, issues.errors)}`
            : basePrompt;
          const next: ConversionPlan = await callStructured(ctx, {
            ...llmOpts(ctx),
            key: "plan",
            effort: ctx.globalArgs.effort,
            system: PLAN_SYSTEM,
            prompt,
            schema: ConversionPlanSchema,
          });
          plan = next;
          issues = validatePlan(next, exts, opts);
          if (!issues.errors.length || rounds >= maxRepairs) break;
          ctx.logger.warning(
            "Plan failed validation ({n} errors); asking Claude to revise",
            { n: issues.errors.length },
          );
        }

        if (issues.errors.length) {
          throw new Error(
            `The plan still failed validation after ${rounds} repair round(s):\n- ${
              issues.errors.join("\n- ")
            }\n` +
              "Re-run with more guidance, more extraQueries on discover, or a higher maxRepairs.",
          );
        }
        for (const w of issues.warnings) ctx.logger.warning("{w}", { w });
        ctx.logger.info(
          "Planned workflow {wf} ({auto} automation) after {r} repair round(s)",
          {
            wf: plan!.workflow.name,
            auto: plan!.automatable,
            r: rounds,
          },
        );
        const handle = await ctx.writeResource("plan", "plan", {
          skillName: skill.name,
          skillHash: skill.contentHash,
          workflowName: plan!.workflow.name,
          automatable: plan!.automatable,
          summary: plan!.summary,
          plan: plan!,
          errors: issues.errors,
          warnings: issues.warnings,
          repairRounds: rounds,
          model: ctx.globalArgs.model,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    apply: {
      description:
        "Write the planned workflow and extension scaffolds into the repo, and optionally pull extensions",
      arguments: z.object({
        workflowsDir: z.string().default("workflows").describe(
          "Where to write the workflow, relative to the repo",
        ),
        extensionsDir: z.string().default("extensions/models").describe(
          "Where to write model scaffolds",
        ),
        overwrite: z.boolean().default(false).describe(
          "Overwrite existing scaffold files (the workflow file is always updated in place, keeping its id)",
        ),
        install: z.boolean().default(false).describe(
          "Run `swamp extension pull` for each planned extension",
        ),
        validate: z.boolean().default(true).describe(
          "Run `swamp workflow validate` on the written workflow and record the result (expect failures for extensions not yet pulled)",
        ),
      }),
      execute: async (
        args: {
          workflowsDir: string;
          extensionsDir: string;
          overwrite: boolean;
          install: boolean;
          validate: boolean;
        },
        ctx: Ctx,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const planData = await readRequired<PlanData>(ctx, "plan", "plan");
        const plan = planData.plan;
        const handles: DataHandle[] = [];
        const warnings = [...planData.warnings];
        const skipped: { path: string; reason: string }[] = [];
        const scaffolded: string[] = [];

        const skill = await ctx.readResource!("skill") as SkillData | null;
        if (skill && skill.contentHash !== planData.skillHash) {
          warnings.push(
            "The skill changed after this plan was made; re-run discover and plan to pick up the changes.",
          );
        }

        // Workflow
        const wfRel =
          `${args.workflowsDir}/workflow-${plan.workflow.name}.yaml`;
        const wfPath = resolvePath(ctx.repoDir, wfRel);
        const id = await existingWorkflowId(wfPath) ?? crypto.randomUUID();
        const yaml = renderWorkflowYaml(plan, {
          id,
          sourceSkill: planData.skillName,
        });
        await Deno.mkdir(resolvePath(ctx.repoDir, args.workflowsDir), {
          recursive: true,
        });
        await Deno.writeTextFile(wfPath, yaml);
        handles.push(
          await ctx.createFileWriter(
            "workflowYaml",
            `workflow-${plan.workflow.name}`,
          ).writeText(yaml),
        );

        // Scaffolds
        const extDir = resolvePath(ctx.repoDir, args.extensionsDir);
        await Deno.mkdir(extDir, { recursive: true });
        const version = calver();
        const scaffolds = [
          ...plan.extensionsToCreate.map((spec) => ({
            fileName: spec.fileName,
            source: renderModelScaffold(spec, {
              sourceSkill: planData.skillName,
              version,
            }),
          })),
          ...plan.extensionsToExtend.map((spec) => ({
            fileName: spec.fileName,
            source: renderExtensionScaffold(spec, {
              sourceSkill: planData.skillName,
            }),
          })),
        ];
        for (const { fileName, source } of scaffolds) {
          const rel = `${args.extensionsDir}/${fileName}`;
          if (!args.overwrite && await exists(`${extDir}/${fileName}`)) {
            skipped.push({
              path: rel,
              reason: "exists (pass overwrite=true to replace)",
            });
            continue;
          }
          await Deno.writeTextFile(`${extDir}/${fileName}`, source);
          scaffolded.push(rel);
          handles.push(
            // Prefixed so a scaffold named e.g. plan.ts can't collide with the plan resource instance.
            await ctx.createFileWriter(
              "scaffold",
              `scaffold-${fileName.replace(/\.ts$/, "")}`,
            ).writeText(source),
          );
        }

        // Extensions
        const packages = [
          ...new Set(plan.extensionsToPull.map((p) => p.package)),
        ];
        const pullCommands = packages.map((p) => `swamp extension pull ${p}`);
        const pulled: { package: string; ok: boolean; output: string }[] = [];
        if (args.install) {
          for (const pkg of packages) {
            const out = await runSwamp(ctx, [
              "extension",
              "pull",
              pkg,
              "--yes",
            ]);
            pulled.push({
              package: pkg,
              ok: out.success,
              output: `${out.stdout}${out.stderr}`.trim().slice(-2000),
            });
            if (!out.success) {
              warnings.push(
                `swamp extension pull ${pkg} failed; see pulled[].output.`,
              );
            }
          }
        }

        // Validation sees the installed types' real schemas, which catches what the
        // registry metadata could not (e.g. required arguments it doesn't publish).
        const validation = {
          ran: false,
          passed: false,
          failures: [] as string[],
        };
        if (args.validate) {
          const out = await runSwamp(ctx, [
            "workflow",
            "validate",
            plan.workflow.name,
            "--json",
          ]);
          validation.ran = true;
          try {
            const result = JSON.parse(out.stdout) as {
              passed?: boolean;
              validations?: {
                name: string;
                passed: boolean;
                error?: string;
                message?: string;
              }[];
              error?: string;
            };
            validation.passed = result.passed === true;
            validation.failures = (result.validations ?? []).filter((v) =>
              !v.passed
            )
              .map((v) => `${v.name}: ${v.error ?? v.message ?? "failed"}`);
            if (result.error) validation.failures.push(result.error);
          } catch {
            validation.failures.push(
              `swamp workflow validate produced no JSON: ${
                (out.stderr || out.stdout).slice(-1000)
              }`,
            );
          }
          for (const f of validation.failures) {
            warnings.push(`workflow validate: ${f}`);
          }
        }

        const nextSteps: string[] = [];
        const untrusted = packages.filter((p) => !p.startsWith("@swamp/"));
        if (!args.install && packages.length) nextSteps.push(...pullCommands);
        if (untrusted.length) {
          const collectives = [
            ...new Set(untrusted.map((p) => p.split("/")[0].slice(1))),
          ];
          nextSteps.push(
            `Review and trust non-official collectives before use: ${
              collectives.map((c) => `swamp extension trust add ${c}`).join(
                "; ",
              )
            }`,
          );
        }
        for (const v of plan.vaultSecrets) {
          nextSteps.push(
            `swamp vault put ${v.vault} ${v.key}   # ${v.purpose}`,
          );
        }
        if (scaffolded.length) {
          nextSteps.push(
            `Implement the stub methods in: ${
              scaffolded.join(", ")
            } (they throw until implemented)`,
          );
        }
        if (plan.report.needed) {
          nextSteps.push(
            `Create a report extension: ${plan.report.description}`,
          );
        }
        if (!validation.passed) {
          nextSteps.push(
            `Fix the workflow until it validates: swamp workflow validate ${plan.workflow.name} --json`,
          );
        }
        for (const q of plan.openQuestions) nextSteps.push(`Decide: ${q}`);

        handles.push(
          await ctx.writeResource("conversion", "conversion", {
            skillName: planData.skillName,
            workflowName: plan.workflow.name,
            workflowPath: wfRel,
            scaffolded,
            skipped,
            pullCommands,
            pulled,
            validation,
            vaultSecrets: plan.vaultSecrets,
            nextSteps,
            warnings,
            timestamp: new Date().toISOString(),
          }),
        );
        ctx.logger.info("Wrote {wf}; scaffolded {n} extension file(s)", {
          wf: wfRel,
          n: scaffolded.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
