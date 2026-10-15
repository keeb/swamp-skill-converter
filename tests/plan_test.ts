import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import {
  type ConversionPlan,
  ConversionPlanSchema,
  decodeValue,
  extensionSpecName,
  findCycle,
  renderExtensionScaffold,
  renderModelScaffold,
  renderWorkflowYaml,
  toStructuredOutputSchema,
  validatePlan,
} from "../extensions/models/skill_converter/plan.ts";
import type { CatalogExtension } from "../extensions/models/skill_converter/registry.ts";

const catalog: CatalogExtension[] = [{
  name: "@swamp/claude",
  description: "Claude",
  latestVersion: "2026.01.01.1",
  official: true,
  pullCount: 10,
  scoreGrade: "A",
  matchedQueries: ["claude"],
  types: [{ type: "@swamp/claude", globalArguments: [], methods: [{ name: "generate", description: "", arguments: [] }] }],
  workflows: [],
}];

const step = (over: Partial<ConversionPlan["workflow"]["jobs"][number]["steps"][number]>) => ({
  name: "s",
  description: "d",
  kind: "model_method" as const,
  dependsOn: [],
  modelType: null,
  modelName: null,
  methodName: null,
  globalArgs: [],
  inputs: [],
  prompt: null,
  expr: null,
  message: null,
  guard: null,
  allowFailure: false,
  ...over,
});

function basePlan(): ConversionPlan {
  return {
    summary: "s",
    automatable: "partial",
    rationale: "r",
    extensionsToPull: [{ package: "@swamp/claude", types: ["@swamp/claude"], reason: "llm" }],
    extensionsToCreate: [{
      type: "@acme/postgres",
      fileName: "postgres.ts",
      service: "postgres",
      description: "Postgres backups",
      globalArguments: [
        { name: "password", type: "string", description: "DB password", required: true, sensitive: true },
        { name: "baseUrl", type: "string", description: "API", required: false, sensitive: false },
      ],
      methods: [{
        name: "dumpDatabase",
        description: "Dump one database",
        arguments: [{ name: "retainDays", type: "integer", description: "Days to keep", required: true, sensitive: false }],
        output: "dump path and size",
        implementationNotes: "pg_dump -Fc <database>\nupload to object storage",
      }],
    }],
    extensionsToExtend: [],
    vaultSecrets: [{ vault: "postgres", key: "PASSWORD", purpose: "API" }],
    workflow: {
      name: "nightly-db-backup",
      description: "d",
      inputs: [
        { name: "retainDays", type: "integer", description: "Days to keep", required: true, default: null },
        { name: "bucket", type: "string", description: "b", required: false, default: "\"backups\"" },
      ],
      jobs: [{
        name: "backup",
        description: "d",
        dependsOn: [],
        steps: [
          step({
            name: "dump",
            modelType: "@acme/postgres",
            modelName: "postgres",
            methodName: "dumpDatabase",
            globalArgs: [{ key: "password", value: "${{ vault.get(postgres, PASSWORD) }}" }],
            inputs: [{ key: "retainDays", value: "${{ inputs.retainDays }}" }, { key: "limit", value: "5" }],
          }),
          step({ name: "approve", kind: "manual_approval", prompt: "OK?", dependsOn: ["dump"] }),
        ],
      }, {
        name: "report",
        description: "d",
        dependsOn: ["backup"],
        steps: [
          step({ name: "summarize", modelType: "@swamp/claude", modelName: "claude", methodName: "generate" }),
          step({
            name: "check",
            kind: "assert",
            expr: 'data.latest("claude", "result").attributes.ok == true',
            message: "not ok",
            dependsOn: ["summarize"],
          }),
        ],
      }],
    },
    report: { needed: false, description: "" },
    openQuestions: [],
  };
}

const opts = { collective: "acme" };

Deno.test("base plan satisfies the schema and validates cleanly", () => {
  const plan = ConversionPlanSchema.parse(basePlan());
  assertEquals(validatePlan(plan, catalog, opts), { errors: [], warnings: [] });
});

Deno.test("structured-output schema closes every object and drops unsupported keywords", () => {
  const schema = toStructuredOutputSchema(ConversionPlanSchema);
  const objects: Record<string, unknown>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o.type === "object") objects.push(o);
    for (const k of ["minLength", "maxLength", "minimum", "maximum", "pattern", "$schema"]) assert(!(k in o), k);
    Object.values(o).forEach(walk);
  };
  walk(schema);
  assert(objects.length > 5);
  for (const o of objects) {
    assertEquals(o.additionalProperties, false);
    assertEquals(new Set(o.required as string[]), new Set(Object.keys(o.properties as object)));
  }
});

Deno.test("validatePlan rejects packages and types not in the catalog", () => {
  const plan = basePlan();
  plan.extensionsToPull = [
    { package: "@ghost/pkg", types: ["@ghost/pkg"], reason: "" },
    { package: "@swamp/claude", types: ["@swamp/nope"], reason: "" },
  ];
  const { errors } = validatePlan(plan, catalog, opts);
  assert(errors.some((e) => e.includes("@ghost/pkg is not in the discovered catalog")));
  assert(errors.some((e) => e.includes("has no model type @swamp/nope")));
  assert(errors.some((e) => e.includes("uses model type @swamp/claude, which is not pulled")));
});

Deno.test("validatePlan rejects unknown methods, bad references, and cycles", () => {
  const plan = basePlan();
  const backup = plan.workflow.jobs[0];
  backup.steps[0].methodName = "nope";
  backup.steps[1].dependsOn = ["approve"];
  backup.steps[0].inputs.push({ key: "x", value: "${{ inputs.missing }}" });
  plan.workflow.jobs[1].dependsOn = ["report"];
  plan.workflow.jobs.push({ ...plan.workflow.jobs[1], name: "report" });
  const { errors } = validatePlan(plan, catalog, opts);
  const all = errors.join("\n");
  assertStringIncludes(all, "calls @acme/postgres.nope, which does not exist");
  assertStringIncludes(all, "Step dependency cycle in job backup");
  assertStringIncludes(all, "undeclared workflow input missing");
  assertStringIncludes(all, "Duplicate job name report");
  assertStringIncludes(all, "Job dependency cycle");
});

Deno.test("validatePlan requires method arguments the catalog or a created type marks required", () => {
  const plan = basePlan();
  plan.workflow.jobs[0].steps[0].inputs = [];
  const withArgs = structuredClone(catalog);
  withArgs[0].types[0].methods[0].arguments = [{ name: "prompt", type: "string", required: true, description: "" }];
  const { errors } = validatePlan(plan, withArgs, opts);
  assert(errors.some((e) => e.includes("dump is missing required inputs for @acme/postgres.dumpDatabase: retainDays")));
  assert(errors.some((e) => e.includes("summarize is missing required inputs for @swamp/claude.generate: prompt")));
});

Deno.test("validatePlan rejects reserved collectives and types that already exist", () => {
  const plan = basePlan();
  plan.extensionsToCreate[0].type = "@swamp/claude";
  const { errors } = validatePlan(plan, catalog, opts);
  assert(errors.some((e) => e.includes("reserved collective")));
  assert(errors.some((e) => e.includes("already exists in the registry")));
});

Deno.test("validatePlan warns on command/shell and unused vault secrets", () => {
  const plan = basePlan();
  plan.workflow.jobs[0].steps[0] = step({
    name: "dump",
    modelType: "command/shell",
    modelName: "sh",
    methodName: "execute",
  });
  const { errors, warnings } = validatePlan(plan, catalog, opts);
  assertEquals(errors, []);
  assert(warnings.some((w) => w.includes("command/shell")));
  assert(warnings.some((w) => w.includes("postgres/PASSWORD is declared but no step references")));
});

Deno.test("findCycle", () => {
  assertEquals(findCycle(new Map([["a", ["b"]], ["b", []]])), []);
  assertEquals(findCycle(new Map([["a", ["b"]], ["b", ["a"]]])), ["a", "b", "a"]);
});

Deno.test("decodeValue keeps expressions and non-JSON as strings", () => {
  assertEquals(decodeValue("3"), 3);
  assertEquals(decodeValue("true"), true);
  assertEquals(decodeValue("\"main\""), "main");
  assertEquals(decodeValue("${{ inputs.retainDays }}"), "${{ inputs.retainDays }}");
  assertEquals(decodeValue("plain text"), "plain text");
});

Deno.test("renderWorkflowYaml produces a swamp workflow document", () => {
  const yaml = renderWorkflowYaml(basePlan(), { id: "11111111-1111-4111-8111-111111111111", sourceSkill: "backup" });
  assert(yaml.startsWith("# Generated by @keeb/skill-converter"));
  // deno-lint-ignore no-explicit-any
  const doc = parseYaml(yaml) as any;
  assertEquals(doc.id, "11111111-1111-4111-8111-111111111111");
  assertEquals(doc.version, 1);
  assertEquals(doc.inputs.required, ["retainDays"]);
  assertEquals(doc.inputs.properties.bucket.default, "backups");
  const [backup, report] = doc.jobs;
  assertEquals(report.dependsOn, [{ job: "backup", condition: { type: "succeeded" } }]);
  assertEquals(backup.steps[0].task, {
    type: "model_method",
    modelType: "@acme/postgres",
    modelName: "postgres",
    methodName: "dumpDatabase",
    globalArgs: { password: "${{ vault.get(postgres, PASSWORD) }}" },
    inputs: { retainDays: "${{ inputs.retainDays }}", limit: 5 },
  });
  assertEquals(backup.steps[1].task, { type: "manual_approval", prompt: "OK?" });
  assertEquals(backup.steps[1].dependsOn, [{ step: "dump", condition: { type: "succeeded" } }]);
  assertEquals(report.steps[1].task.severity, "high");
});

Deno.test("renderModelScaffold emits a model with stub methods", () => {
  const src = renderModelScaffold(basePlan().extensionsToCreate[0], { sourceSkill: "backup", version: "2026.10.15.1" });
  assertStringIncludes(src, 'import { z } from "npm:zod@4";');
  assertStringIncludes(src, 'type: "@acme/postgres"');
  assertStringIncludes(src, "password: z.string().meta({ sensitive: true }).describe(\"DB password\")");
  assertStringIncludes(src, "baseUrl: z.string().optional()");
  assertStringIncludes(src, "retainDays: z.number().int().describe(\"Days to keep\")");
  assertStringIncludes(src, "// pg_dump -Fc <database>\n");
  assertStringIncludes(src, 'throw new Error("dumpDatabase is not implemented yet');
});

Deno.test("renderExtensionScaffold declares its own resource spec", () => {
  assertEquals(extensionSpecName("postgres_dump-extras.ts"), "postgresDumpExtras");
  const src = renderExtensionScaffold({
    targetType: "@swamp/claude",
    fileName: "claude_summary.ts",
    reason: "needs summaries",
    methods: basePlan().extensionsToCreate[0].methods,
  }, { sourceSkill: "backup" });
  assertStringIncludes(src, "export const extension");
  assertStringIncludes(src, "claudeSummary: {");
  assertStringIncludes(src, 'writeResource("claudeSummary", "dumpDatabase"');
});

Deno.test("generated scaffolds type-check", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plan = basePlan();
    await Deno.writeTextFile(
      `${dir}/model.ts`,
      renderModelScaffold(plan.extensionsToCreate[0], { sourceSkill: "backup", version: "2026.10.15.1" }),
    );
    await Deno.writeTextFile(
      `${dir}/ext.ts`,
      renderExtensionScaffold({
        targetType: "@swamp/claude",
        fileName: "ext.ts",
        reason: "r",
        methods: plan.extensionsToCreate[0].methods,
      }, { sourceSkill: "backup" }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/model.ts`, `${dir}/ext.ts`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
