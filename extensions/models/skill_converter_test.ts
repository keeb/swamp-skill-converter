import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import { model } from "./skill_converter.ts";

const FIXTURE = new URL("../../tests/fixtures/nightly-db-backup", import.meta.url).pathname;

// A plan that only uses what the fake registry offers plus one created type.
const PLAN = {
  summary: "s",
  automatable: "partial",
  rationale: "r",
  extensionsToPull: [{ package: "@acme/postgres", types: ["@acme/postgres"], reason: "dumps" }],
  extensionsToCreate: [{
    type: "@test/make",
    fileName: "make_runner.ts",
    service: "make",
    description: "Run make targets",
    globalArguments: [],
    methods: [{
      name: "runTargets",
      description: "Run targets",
      arguments: [{ name: "targets", type: "array", description: "Targets", required: true, sensitive: false }],
      output: "results[]",
      implementationNotes: "make <target> per target",
    }],
  }],
  extensionsToExtend: [],
  vaultSecrets: [{ vault: "postgres", key: "PASSWORD", purpose: "DB login" }],
  workflow: {
    name: "nightly-db-backup",
    description: "d",
    inputs: [{ name: "database", type: "string", description: "Database", required: true, default: null }],
    jobs: [{
      name: "main",
      description: "d",
      dependsOn: [],
      steps: [{
        name: "dump",
        description: "d",
        kind: "model_method",
        dependsOn: [],
        modelType: "@acme/postgres",
        modelName: "postgres",
        methodName: "listDumps",
        globalArgs: [{ key: "password", value: "${{ vault.get(postgres, PASSWORD) }}" }],
        inputs: [{ key: "database", value: "${{ inputs.database }}" }],
        prompt: null,
        expr: null,
        message: null,
        guard: null,
        allowFailure: false,
      }, {
        name: "checks",
        description: "d",
        kind: "model_method",
        dependsOn: ["dump"],
        modelType: "@test/make",
        modelName: "make",
        methodName: "runTargets",
        globalArgs: [],
        inputs: [{ key: "targets", value: "[\"test\",\"lint\"]" }],
        prompt: null,
        expr: null,
        message: null,
        guard: null,
        allowFailure: false,
      }],
    }],
  },
  report: { needed: false, description: "" },
  openQuestions: ["Which bucket?"],
};

type Answers = { discover?: unknown; plan?: unknown[] };

function fakeContext(repoDir: string, answers: Answers) {
  const store = new Map<string, Record<string, unknown>>();
  const files = new Map<string, string>();
  const llmData: { name: string; attributes: Record<string, unknown> }[] = [];
  const calls: Record<string, unknown>[] = [];
  const planQueue = [...(answers.plan ?? [])];
  const ctx = {
    globalArgs: {
      collective: "test",
      llmModel: "llm",
      model: "claude-opus-5-5",
      effort: "high" as const,
      timeoutSeconds: 60,
      registryUrl: "https://registry.test",
    },
    repoDir,
    logger: { info: () => {}, warning: () => {} },
    writeResource: (_spec: string, name: string, data: Record<string, unknown>) => {
      store.set(name, structuredClone(data));
      return Promise.resolve({ name });
    },
    readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
    createFileWriter: (_spec: string, name: string) => ({
      writeText: (text: string) => {
        files.set(name, text);
        return Promise.resolve({ name });
      },
    }),
    runModel: (opts: { method: string; arguments?: Record<string, unknown> }) => {
      calls.push(opts.arguments ?? {});
      const req = (opts.arguments!.requests as { key: string }[])[0];
      const structured = req.key === "discover" ? answers.discover : planQueue.shift();
      llmData.splice(0, llmData.length, {
        name: `cli-skill-converter-${req.key}`,
        attributes: { ok: true, structured, timestamp: new Date().toISOString() },
      });
      return Promise.resolve({ ok: true as const, resources: [] });
    },
    readModelData: () => Promise.resolve(llmData),
  };
  return { ctx, store, files, calls };
}

function withRegistry<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("/search")
      ? { extensions: url.searchParams.get("q") === "postgres" ? [{ name: "@acme/postgres", contentTypes: ["models"] }] : [] }
      : {
        name: decodeURIComponent(url.pathname.split("/")[4]),
        latestVersionDetail: {
          models: [{ type: "@acme/postgres", methods: [{ name: "listDumps", arguments: [{ name: "database", type: "string", required: true }] }] }],
        },
      };
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

const m = model.methods;

Deno.test("parse → discover → plan → apply writes a workflow and scaffolds", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    const { ctx, store, files, calls } = fakeContext(repoDir, {
      discover: { services: ["postgres", "make"], queries: ["postgres"] },
      plan: [PLAN],
    });
    await m.parse.execute({ path: FIXTURE }, ctx);
    assertEquals((store.get("skill") as { name: string }).name, "nightly-db-backup");

    await withRegistry(() =>
      m.discover.execute({ extraQueries: [], useClaude: true, perQuery: 5, pinned: [], maxExtensions: 5 }, ctx)
    );
    const catalog = store.get("catalog") as { queries: string[]; services: string[]; extensions: { name: string }[] };
    assertEquals(catalog.services, ["postgres"], "build tools are filtered out of services");
    assert(!catalog.queries.includes("make"));
    assertEquals(catalog.extensions.map((e) => e.name), ["@acme/postgres"]);
    // The system prompt travels as a per-request method argument, never a global.
    assert(!("systemPrompt" in calls[0]));

    await m.plan.execute({ localTypes: [], maxRepairs: 0 }, ctx);
    assertEquals((store.get("plan") as { errors: string[] }).errors, []);

    await m.apply.execute({
      workflowsDir: "workflows",
      extensionsDir: "extensions/models",
      overwrite: false,
      install: false,
      validate: false,
    }, ctx);
    const conversion = store.get("conversion") as { scaffolded: string[]; nextSteps: string[]; workflowPath: string };
    assertEquals(conversion.scaffolded, ["extensions/models/make_runner.ts"]);
    assert(files.has("scaffold-make_runner"), "scaffold artifacts are prefixed");
    assert(conversion.nextSteps.includes("swamp extension pull @acme/postgres"));
    assert(conversion.nextSteps.some((s) => s.startsWith("swamp vault put postgres PASSWORD")));
    assert(conversion.nextSteps.includes("Decide: Which bucket?"));

    const yaml = await Deno.readTextFile(`${repoDir}/${conversion.workflowPath}`);
    // deno-lint-ignore no-explicit-any
    const doc = parseYaml(yaml) as any;
    assertEquals(doc.name, "nightly-db-backup");
    assertEquals(files.get("workflow-nightly-db-backup"), yaml);

    // Re-applying keeps the workflow id and does not clobber scaffolds.
    await m.apply.execute({
      workflowsDir: "workflows",
      extensionsDir: "extensions/models",
      overwrite: false,
      install: false,
      validate: false,
    }, ctx);
    // deno-lint-ignore no-explicit-any
    const again = parseYaml(await Deno.readTextFile(`${repoDir}/${conversion.workflowPath}`)) as any;
    assertEquals(again.id, doc.id);
    assertEquals((store.get("conversion") as { skipped: { path: string }[] }).skipped.map((s) => s.path), [
      "extensions/models/make_runner.ts",
    ]);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("plan repairs an invalid plan by re-prompting with the errors", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    const broken = structuredClone(PLAN);
    broken.workflow.jobs[0].steps[0].methodName = "nope";
    const { ctx, store, calls } = fakeContext(repoDir, { discover: { services: [], queries: ["postgres"] }, plan: [broken, PLAN] });
    await m.parse.execute({ path: FIXTURE }, ctx);
    await withRegistry(() =>
      m.discover.execute({ extraQueries: [], useClaude: true, perQuery: 5, pinned: [], maxExtensions: 5 }, ctx)
    );
    await m.plan.execute({ localTypes: [], maxRepairs: 1 }, ctx);
    assertEquals((store.get("plan") as { repairRounds: number }).repairRounds, 1);
    const repairPrompt = (calls[2].requests as { prompt: string }[])[0].prompt;
    assertStringIncludes(repairPrompt, "<previous_plan>");
    assertStringIncludes(repairPrompt, "calls @acme/postgres.nope, which does not exist");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("plan throws (and writes nothing) when repairs run out", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    const broken = structuredClone(PLAN);
    broken.extensionsToPull[0].package = "@ghost/pkg";
    const { ctx, store } = fakeContext(repoDir, { discover: { services: [], queries: ["postgres"] }, plan: [broken] });
    await m.parse.execute({ path: FIXTURE }, ctx);
    await withRegistry(() =>
      m.discover.execute({ extraQueries: [], useClaude: true, perQuery: 5, pinned: [], maxExtensions: 5 }, ctx)
    );
    await assertRejects(() => m.plan.execute({ localTypes: [], maxRepairs: 0 }, ctx), Error, "still failed validation");
    assertEquals(store.has("plan"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("methods fail clearly when run out of order or with bad arguments", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    const { ctx } = fakeContext(repoDir, {});
    await assertRejects(
      () => m.discover.execute({ extraQueries: [], useClaude: false, perQuery: 5, pinned: [], maxExtensions: 5 }, ctx),
      Error,
      "run 'parse' first",
    );
    await m.parse.execute({ path: FIXTURE }, ctx);
    await assertRejects(
      () => m.discover.execute({ extraQueries: [], useClaude: false, perQuery: 0, pinned: [], maxExtensions: 5 }, ctx),
      Error,
      "perQuery must be an integer from 1 to 25",
    );
    await assertRejects(() => m.plan.execute({ localTypes: [], maxRepairs: 0 }, ctx), Error, "run 'discover' first");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});
