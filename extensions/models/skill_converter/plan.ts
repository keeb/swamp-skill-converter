/**
 * The conversion plan: the structured description of how a skill maps onto
 * swamp primitives, plus validation and rendering into a workflow YAML file
 * and extension model scaffolds.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { stringify as stringifyYaml } from "npm:yaml@2.9.1";
import type { CatalogExtension } from "./registry.ts";

// Every object is closed and every key required (nullable instead of
// optional) so the schema is accepted by Claude structured outputs as-is.

/** Search terms Claude extracts from a skill before registry discovery. */
export const DiscoveryTermsSchema = z.object({
  services: z.array(z.string()).describe(
    "External services, platforms, or CLIs the skill operates on, lowercase (e.g. aws, jira, kubernetes, postgres)",
  ),
  queries: z.array(z.string()).describe(
    "Short swamp registry search queries, one service or capability each (e.g. 'postgres', 's3', 'claude', 'slack')",
  ),
});
/** Inferred type of {@link DiscoveryTermsSchema}. */
export type DiscoveryTerms = z.infer<typeof DiscoveryTermsSchema>;

const FieldTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

const FieldSchema = z.object({
  name: z.string().describe("camelCase argument name"),
  type: FieldTypeSchema,
  description: z.string(),
  required: z.boolean(),
  sensitive: z.boolean().describe(
    "True for secrets; the value must come from a vault",
  ),
});

const KeyValueSchema = z.object({
  key: z.string(),
  value: z.string().describe(
    'JSON-encoded value (e.g. "\\"main\\"", "3", "true") or a bare swamp expression string like ${{ inputs.repo }}',
  ),
});

const StepSchema = z.object({
  name: z.string().describe("kebab-case, unique within the job"),
  description: z.string(),
  kind: z.enum(["model_method", "manual_approval", "assert"]),
  dependsOn: z.array(z.string()).describe(
    "Names of earlier steps in the same job that must succeed first",
  ),
  modelType: z.string().nullable().describe(
    "model_method only: model type, e.g. @swamp/git or @acme/postgres",
  ),
  modelName: z.string().nullable().describe(
    "model_method only: kebab-case instance name; reuse the same name to share data between steps",
  ),
  methodName: z.string().nullable().describe(
    "model_method only: method on modelType",
  ),
  globalArgs: z.array(KeyValueSchema).describe(
    "model_method only: global arguments for the model instance",
  ),
  inputs: z.array(KeyValueSchema).describe(
    "model_method only: method arguments",
  ),
  prompt: z.string().nullable().describe(
    "manual_approval only: what the operator must check or decide",
  ),
  expr: z.string().nullable().describe(
    "assert only: CEL predicate over data.latest(...)",
  ),
  message: z.string().nullable().describe("assert only: failure message"),
  guard: z.string().nullable().describe(
    "Optional ${{ }} CEL expression; truthy skips the step (idempotency)",
  ),
  allowFailure: z.boolean(),
});

const JobSchema = z.object({
  name: z.string().describe("kebab-case, unique"),
  description: z.string(),
  dependsOn: z.array(z.string()).describe(
    "Names of jobs that must succeed first",
  ),
  steps: z.array(StepSchema),
});

const MethodSpecSchema = z.object({
  name: z.string().describe("camelCase method name"),
  description: z.string(),
  arguments: z.array(FieldSchema),
  output: z.string().describe(
    "What the method writes as its resource output, field by field",
  ),
  implementationNotes: z.string().describe(
    "API endpoints / CLI calls / logic the implementer needs",
  ),
});

/** The full plan Claude produces for converting a skill. */
export const ConversionPlanSchema = z.object({
  summary: z.string().describe(
    "Two or three sentences: what the skill does and what the swamp version does",
  ),
  automatable: z.enum(["full", "partial", "none"]),
  rationale: z.string().describe(
    "Why this split between automation and human/LLM judgment",
  ),
  extensionsToPull: z.array(z.object({
    package: z.string().describe(
      "Registry package name exactly as it appears in the catalog",
    ),
    types: z.array(z.string()).describe(
      "Model types from that package the workflow uses",
    ),
    reason: z.string(),
  })),
  extensionsToCreate: z.array(z.object({
    type: z.string().describe("New model type, @<collective>/<name>"),
    fileName: z.string().describe("snake_case file name ending in .ts"),
    service: z.string(),
    description: z.string(),
    globalArguments: z.array(FieldSchema),
    methods: z.array(MethodSpecSchema),
  })),
  extensionsToExtend: z.array(z.object({
    targetType: z.string().describe(
      "Existing type being extended via `export const extension`",
    ),
    fileName: z.string(),
    reason: z.string(),
    methods: z.array(MethodSpecSchema),
  })),
  vaultSecrets: z.array(z.object({
    vault: z.string(),
    key: z.string(),
    purpose: z.string(),
  })),
  workflow: z.object({
    name: z.string().describe("kebab-case workflow name"),
    description: z.string(),
    inputs: z.array(z.object({
      name: z.string(),
      type: FieldTypeSchema,
      description: z.string(),
      required: z.boolean(),
      default: z.string().nullable().describe("JSON-encoded default, or null"),
    })),
    jobs: z.array(JobSchema),
  }),
  report: z.object({
    needed: z.boolean(),
    description: z.string().describe(
      "If needed: what a report extension should aggregate from the run",
    ),
  }),
  openQuestions: z.array(z.string()),
});
/** Inferred type of {@link ConversionPlanSchema}. */
export type ConversionPlan = z.infer<typeof ConversionPlanSchema>;
/** One workflow step in a plan. */
export type PlanStep = z.infer<typeof StepSchema>;
/** One method spec on a created or extended type. */
export type MethodSpec = z.infer<typeof MethodSpecSchema>;
/** One argument field on a created type or method. */
export type FieldSpec = z.infer<typeof FieldSchema>;

const UNSUPPORTED_KEYS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "pattern",
  "$schema",
]);

/**
 * Converts a zod schema to a JSON schema Claude structured outputs accepts:
 * every object closed with `additionalProperties: false`, unsupported
 * constraint keywords removed.
 */
export function toStructuredOutputSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_KEYS.has(k)) continue;
      out[k] = walk(v);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Problems found when checking a plan against the catalog and workflow rules. */
export interface PlanIssues {
  /** Must be fixed; the plan is not usable. */
  errors: string[];
  /** Worth surfacing; the plan is still usable. */
  warnings: string[];
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const TYPE_NAME = /^@[a-z0-9_-]+\/[a-z0-9_/-]+$/;

/** Returns the names of nodes on a dependency cycle, or [] when acyclic. */
export function findCycle(nodes: Map<string, string[]>): string[] {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return stack.slice(stack.indexOf(n)).concat(n);
    state.set(n, 1);
    stack.push(n);
    for (const d of nodes.get(n) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return [];
}

/**
 * Checks structural workflow rules (unique names, valid references, no
 * cycles, per-kind required fields) and that every model type the workflow
 * calls is either pulled from the catalog, created, or a built-in.
 */
export function validatePlan(
  plan: ConversionPlan,
  catalog: CatalogExtension[],
  opts: { collective: string; localTypes?: string[] },
): PlanIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const wf = plan.workflow;

  // Type → method names, from every source the workflow may draw on.
  const known = new Map<string, Set<string> | null>();
  // "type.method" → required argument names, where the catalog publishes them.
  const requiredArgs = new Map<string, string[]>();
  const catalogByPkg = new Map(catalog.map((e) => [e.name, e]));
  for (const pull of plan.extensionsToPull) {
    const ext = catalogByPkg.get(pull.package);
    if (!ext) {
      errors.push(
        `extensionsToPull: ${pull.package} is not in the discovered catalog; only pull packages that were found.`,
      );
      continue;
    }
    for (const t of pull.types) {
      const ct = ext.types.find((x) => x.type === t);
      if (!ct) {
        errors.push(
          `extensionsToPull: ${pull.package} has no model type ${t} (it has: ${
            ext.types.map((x) => x.type).join(", ") || "none listed"
          }).`,
        );
        continue;
      }
      // An empty method list means the registry metadata is incomplete, not that the type has no methods.
      known.set(
        t,
        ct.methods.length ? new Set(ct.methods.map((m) => m.name)) : null,
      );
      for (const m of ct.methods) {
        const req = m.arguments.filter((a) => a.required).map((a) => a.name);
        if (req.length) requiredArgs.set(`${t}.${m.name}`, req);
      }
    }
  }
  for (const c of plan.extensionsToCreate) {
    if (!TYPE_NAME.test(c.type)) {
      errors.push(
        `extensionsToCreate: ${c.type} is not a valid @collective/name type.`,
      );
    }
    if (c.type.startsWith("@swamp/") || c.type.startsWith("@si/")) {
      errors.push(
        `extensionsToCreate: ${c.type} uses a reserved collective; use @${opts.collective}/...`,
      );
    }
    if (!/^[a-z0-9_]+\.ts$/.test(c.fileName)) {
      errors.push(
        `extensionsToCreate: fileName ${c.fileName} must be snake_case and end in .ts.`,
      );
    }
    if (catalog.some((e) => e.types.some((t) => t.type === c.type))) {
      errors.push(
        `extensionsToCreate: ${c.type} already exists in the registry; pull it instead.`,
      );
    }
    known.set(c.type, new Set(c.methods.map((m) => m.name)));
    for (const m of c.methods) {
      const req = m.arguments.filter((a) => a.required).map((a) => a.name);
      if (req.length) requiredArgs.set(`${c.type}.${m.name}`, req);
    }
  }
  for (const x of plan.extensionsToExtend) {
    const base = known.get(x.targetType);
    if (base === undefined && !(opts.localTypes ?? []).includes(x.targetType)) {
      warnings.push(
        `extensionsToExtend: target ${x.targetType} is neither pulled nor created by this plan; make sure it is installed.`,
      );
    }
    const merged = new Set([...(base ?? []), ...x.methods.map((m) => m.name)]);
    known.set(x.targetType, base === null ? null : merged);
  }
  for (const t of opts.localTypes ?? []) if (!known.has(t)) known.set(t, null);
  if (!known.has("command/shell")) {
    known.set("command/shell", new Set(["execute"]));
  }

  if (!KEBAB.test(wf.name)) {
    errors.push(`workflow.name ${wf.name} must be kebab-case.`);
  }
  if (wf.jobs.length === 0) errors.push("workflow has no jobs.");

  const inputNames = new Set(wf.inputs.map((i) => i.name));
  const jobNames = new Set<string>();
  for (const job of wf.jobs) {
    if (jobNames.has(job.name)) errors.push(`Duplicate job name ${job.name}.`);
    jobNames.add(job.name);
    if (!KEBAB.test(job.name)) {
      errors.push(`Job name ${job.name} must be kebab-case.`);
    }
    if (job.steps.length === 0) errors.push(`Job ${job.name} has no steps.`);
  }

  for (const job of wf.jobs) {
    for (const d of job.dependsOn) {
      if (!jobNames.has(d)) {
        errors.push(`Job ${job.name} depends on unknown job ${d}.`);
      }
    }
    const stepNames = new Set<string>();
    for (const step of job.steps) {
      const where = `${job.name}.${step.name}`;
      if (stepNames.has(step.name)) {
        errors.push(`Duplicate step name ${where}.`);
      }
      stepNames.add(step.name);
      if (!KEBAB.test(step.name)) {
        errors.push(`Step name ${where} must be kebab-case.`);
      }
    }
    for (const step of job.steps) {
      const where = `${job.name}.${step.name}`;
      for (const d of step.dependsOn) {
        if (!stepNames.has(d)) {
          errors.push(
            `Step ${where} depends on unknown step ${d} (steps may only depend on steps in the same job).`,
          );
        }
      }
      if (step.kind === "model_method") {
        if (!step.modelType || !step.modelName || !step.methodName) {
          errors.push(
            `Step ${where} is model_method but is missing modelType, modelName, or methodName.`,
          );
        } else {
          if (!KEBAB.test(step.modelName)) {
            errors.push(
              `Step ${where} modelName ${step.modelName} must be kebab-case.`,
            );
          }
          const methods = known.get(step.modelType);
          if (methods === undefined) {
            errors.push(
              `Step ${where} uses model type ${step.modelType}, which is not pulled, created, or extended by this plan.`,
            );
          } else if (methods && !methods.has(step.methodName)) {
            errors.push(
              `Step ${where} calls ${step.modelType}.${step.methodName}, which does not exist (available: ${
                [...methods].join(", ")
              }).`,
            );
          } else {
            const given = new Set(step.inputs.map((kv) => kv.key));
            const missing =
              (requiredArgs.get(`${step.modelType}.${step.methodName}`) ?? [])
                .filter((a) => !given.has(a));
            if (missing.length) {
              errors.push(
                `Step ${where} is missing required inputs for ${step.modelType}.${step.methodName}: ${
                  missing.join(", ")
                }.`,
              );
            }
          }
          if (step.modelType === "command/shell") {
            warnings.push(
              `Step ${where} uses command/shell; that is for ad-hoc commands only, not for wrapping a CLI integration.`,
            );
          }
        }
      } else if (step.kind === "manual_approval" && !step.prompt) {
        errors.push(`Step ${where} is manual_approval but has no prompt.`);
      } else if (step.kind === "assert" && (!step.expr || !step.message)) {
        errors.push(`Step ${where} is assert but is missing expr or message.`);
      }
      for (const kv of [...step.globalArgs, ...step.inputs]) {
        for (
          const m of kv.value.matchAll(/inputs\.([A-Za-z_][A-Za-z0-9_]*)/g)
        ) {
          if (!inputNames.has(m[1])) {
            errors.push(
              `Step ${where} references undeclared workflow input ${m[1]}.`,
            );
          }
        }
      }
    }
    const cycle = findCycle(
      new Map(job.steps.map((s) => [s.name, s.dependsOn])),
    );
    if (cycle.length) {
      errors.push(
        `Step dependency cycle in job ${job.name}: ${cycle.join(" → ")}.`,
      );
    }
  }
  const jobCycle = findCycle(
    new Map(wf.jobs.map((j) => [j.name, j.dependsOn])),
  );
  if (jobCycle.length) {
    errors.push(`Job dependency cycle: ${jobCycle.join(" → ")}.`);
  }

  for (const v of plan.vaultSecrets) {
    const ref = `vault.get(${v.vault}, ${v.key})`;
    const used = wf.jobs.some((j) =>
      j.steps.some((s) => s.globalArgs.some((g) => g.value.includes(ref)))
    );
    if (!used) {
      warnings.push(
        `Vault secret ${v.vault}/${v.key} is declared but no step references \${{ ${ref} }}.`,
      );
    }
  }
  return { errors, warnings };
}

/** Decodes a plan value: JSON when it parses, the raw string otherwise (expressions stay strings). */
export function decodeValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("${{")) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function kvToObject(
  kvs: { key: string; value: string }[],
): Record<string, unknown> {
  return Object.fromEntries(kvs.map((kv) => [kv.key, decodeValue(kv.value)]));
}

function renderStep(step: PlanStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: step.name,
    description: step.description,
  };
  if (step.dependsOn.length) {
    out.dependsOn = step.dependsOn.map((s) => ({
      step: s,
      condition: { type: "succeeded" },
    }));
  }
  if (step.guard) out.guard = step.guard;
  if (step.allowFailure) out.allowFailure = true;
  if (step.kind === "model_method") {
    const task: Record<string, unknown> = {
      type: "model_method",
      modelType: step.modelType,
      modelName: step.modelName,
      methodName: step.methodName,
    };
    if (step.globalArgs.length) task.globalArgs = kvToObject(step.globalArgs);
    if (step.inputs.length) task.inputs = kvToObject(step.inputs);
    out.task = task;
  } else if (step.kind === "manual_approval") {
    out.task = { type: "manual_approval", prompt: step.prompt };
  } else {
    out.task = {
      type: "assert",
      expr: step.expr,
      message: step.message,
      severity: "high",
    };
  }
  return out;
}

/** Renders the plan's workflow as swamp workflow YAML. */
export function renderWorkflowYaml(
  plan: ConversionPlan,
  opts: { id: string; sourceSkill: string },
): string {
  const wf = plan.workflow;
  const doc: Record<string, unknown> = {
    id: opts.id,
    name: wf.name,
    description: wf.description,
    version: 1,
  };
  if (wf.inputs.length) {
    doc.inputs = {
      properties: Object.fromEntries(wf.inputs.map((i) => {
        const p: Record<string, unknown> = {
          type: i.type,
          description: i.description,
        };
        if (i.default !== null) p.default = decodeValue(i.default);
        return [i.name, p];
      })),
      required: wf.inputs.filter((i) => i.required).map((i) => i.name),
    };
  }
  doc.jobs = wf.jobs.map((job) => {
    const j: Record<string, unknown> = {
      name: job.name,
      description: job.description,
    };
    if (job.dependsOn.length) {
      j.dependsOn = job.dependsOn.map((d) => ({
        job: d,
        condition: { type: "succeeded" },
      }));
    }
    j.steps = job.steps.map(renderStep);
    return j;
  });
  const header =
    `# Generated by @keeb/skill-converter from skill "${opts.sourceSkill}".\n` +
    `# Review before running: swamp workflow validate ${wf.name} --json\n`;
  return header + stringifyYaml(doc, { lineWidth: 0 });
}

const ZOD_FOR: Record<FieldSpec["type"], string> = {
  string: "z.string()",
  number: "z.number()",
  integer: "z.number().int()",
  boolean: "z.boolean()",
  array: "z.array(z.unknown())",
  object: "z.record(z.string(), z.unknown())",
};

function zodField(f: FieldSpec, indent: string): string {
  let expr = ZOD_FOR[f.type];
  if (f.sensitive) expr += ".meta({ sensitive: true })";
  if (!f.required) expr += ".optional()";
  if (f.description) expr += `.describe(${JSON.stringify(f.description)})`;
  return `${indent}${f.name}: ${expr},`;
}

function zodObject(fields: FieldSpec[], indent: string): string {
  if (!fields.length) return "z.object({})";
  return `z.object({\n${
    fields.map((f) => zodField(f, indent + "  ")).join("\n")
  }\n${indent}})`;
}

function comment(text: string, indent: string): string {
  return text.split("\n").map((l) => `${indent}// ${l}`.trimEnd()).join("\n");
}

function renderMethod(m: MethodSpec, indent: string, specName: string): string {
  const i = indent;
  return [
    `${i}${m.name}: {`,
    `${i}  description: ${JSON.stringify(m.description)},`,
    `${i}  arguments: ${zodObject(m.arguments, i + "  ")},`,
    `${i}  execute: async (`,
    `${i}    _args: Record<string, unknown>,`,
    `${i}    _context: {`,
    `${i}      globalArgs: Record<string, unknown>;`,
    `${i}      writeResource: (spec: string, name: string, data: Record<string, unknown>) => Promise<{ name: string }>;`,
    `${i}    },`,
    `${i}  ): Promise<{ dataHandles: { name: string }[] }> => {`,
    `${i}    // Output: ${m.output.replace(/\n/g, " ")}`,
    comment(m.implementationNotes, `${i}    `),
    `${i}    // When implemented, write the output and return its handle:`,
    `${i}    //   const handle = await _context.writeResource("${specName}", "${m.name}", {`,
    `${i}    //     method: "${m.name}", timestamp: new Date().toISOString(), ...fields });`,
    `${i}    //   return { dataHandles: [handle] };`,
    `${i}    throw new Error("${m.name} is not implemented yet (scaffolded by @keeb/skill-converter)");`,
    `${i}  },`,
    `${i}},`,
  ].join("\n");
}

/** Today's date as a CalVer extension version (YYYY.MM.DD.1). */
export function calver(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}.${p(now.getUTCMonth() + 1)}.${
    p(now.getUTCDate())
  }.1`;
}

/** Renders a new model type as a TypeScript extension scaffold with stub methods. */
export function renderModelScaffold(
  spec: ConversionPlan["extensionsToCreate"][number],
  opts: { sourceSkill: string; version: string },
): string {
  return `/**
 * ${spec.description.replace(/\*\//g, "* /")}
 *
 * Service: ${spec.service}
 * Scaffolded by @keeb/skill-converter from skill "${opts.sourceSkill}".
 * Every method throws until implemented.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = ${zodObject(spec.globalArguments, "")};

const ResultSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
}).passthrough();

/** Model definition for ${spec.type}. */
export const model = {
  type: ${JSON.stringify(spec.type)},
  version: ${JSON.stringify(opts.version)},
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: ${JSON.stringify(`Output of ${spec.type} methods`)},
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
${spec.methods.map((m) => renderMethod(m, "    ", "result")).join("\n")}
  },
};
`;
}

/** Resource spec name for an extension scaffold: camelCase file stem (no hyphens allowed in spec keys). */
export function extensionSpecName(fileName: string): string {
  const stem = fileName.replace(/\.ts$/, "").replace(
    /[^A-Za-z0-9]+(.)?/g,
    (_, c) => c ? c.toUpperCase() : "",
  );
  return /^[a-z]/.test(stem) ? stem : `ext${stem}`;
}

/** Renders an `export const extension` scaffold adding methods to an existing type. */
export function renderExtensionScaffold(
  spec: ConversionPlan["extensionsToExtend"][number],
  opts: { sourceSkill: string },
): string {
  return `/**
 * Extends ${spec.targetType}: ${spec.reason.replace(/\*\//g, "* /")}
 *
 * Scaffolded by @keeb/skill-converter from skill "${opts.sourceSkill}".
 * Every method throws until implemented.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Adds methods to ${spec.targetType}. */
export const extension = {
  type: ${JSON.stringify(spec.targetType)},
  resources: {
    ${extensionSpecName(spec.fileName)}: {
      description: ${
    JSON.stringify(`Output of methods added by ${spec.fileName}`)
  },
      schema: z.object({
        method: z.string().describe("Method that wrote this result"),
        timestamp: z.string().describe("ISO-8601 time the result was written"),
      }).passthrough(),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: [
    {
${
    spec.methods.map((m) =>
      renderMethod(m, "      ", extensionSpecName(spec.fileName))
    ).join("\n")
  }
    },
  ],
};
`;
}
