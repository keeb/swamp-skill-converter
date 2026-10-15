/**
 * Structured Claude calls, delegated to the `@keeb/anthropic/claude` model's
 * `cli_generate_many` method (the local `claude` CLI login) via `runModel`.
 *
 * `cli_generate_many` is used even for one prompt because it takes the system
 * prompt as a method argument. `runModel` refuses global arguments holding
 * `${{ }}` text, and the converter's prompts quote swamp expressions as examples.
 *
 * @module
 */
import type { z } from "npm:zod@4";
import { toStructuredOutputSchema } from "./plan.ts";

/** The model type every LLM call is delegated to. */
export const LLM_TYPE = "@keeb/anthropic/claude";

/** Subset of the method context needed to call another model. */
export interface LlmContext {
  runModel?: (opts: {
    modelType?: string;
    name?: string;
    definition?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<
    { ok: true; resources: unknown[] } | {
      ok: false;
      error: { message: string };
    }
  >;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<{ name: string; attributes: Record<string, unknown> }[]>;
}

/** Options for one structured call. */
export interface StructuredCallOptions<T extends z.ZodType> {
  /** Name of the @keeb/anthropic/claude instance to run (created if missing). */
  llmModel: string;
  /** Request key; the answer is stored as cli-skill-converter-<key> on the LLM instance. */
  key: string;
  /** Claude model ID passed to the CLI. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
  schema: T;
  timeoutSeconds: number;
}

/** Batch name the converter's requests are stored under on the LLM instance. */
export const LLM_BATCH = "skill-converter";

/**
 * Runs one `cli_generate_many` request with `schema` as the JSON schema and
 * returns the validated structured answer. Throws when the call fails or the
 * answer does not match.
 */
export async function callStructured<T extends z.ZodType>(
  ctx: LlmContext,
  opts: StructuredCallOptions<T>,
): Promise<z.infer<T>> {
  if (!ctx.runModel || !ctx.readModelData) {
    throw new Error(
      "This swamp version does not expose runModel/readModelData to methods; upgrade swamp.",
    );
  }
  const started = new Date().toISOString();
  const res = await ctx.runModel({
    modelType: LLM_TYPE,
    name: opts.llmModel,
    method: "cli_generate_many",
    arguments: {
      model: opts.model,
      batch: LLM_BATCH,
      requests: [{
        key: opts.key,
        prompt: opts.prompt,
        systemPrompt: opts.system,
        jsonSchema: toStructuredOutputSchema(opts.schema),
      }],
      concurrency: 1,
      effort: opts.effort,
      timeoutSeconds: opts.timeoutSeconds,
    },
  });
  if (!res.ok) {
    throw new Error(
      `${LLM_TYPE}.cli_generate_many failed: ${res.error.message}\n` +
        `Is @keeb/anthropic 2026.10.15.1+ installed and the claude CLI logged in?`,
    );
  }
  const name = `cli-${LLM_BATCH}-${opts.key}`;
  const record = (await ctx.readModelData(opts.llmModel, "cliResult")).find((
    r,
  ) => r.name === name);
  const a = record?.attributes;
  if (!a || String(a.timestamp ?? "") < started) {
    throw new Error(`${LLM_TYPE} wrote no ${name} result for this call.`);
  }
  if (!a.ok) {
    throw new Error(
      `Claude call failed: ${String(a.error ?? "unknown error")}`,
    );
  }
  if (a.structured === undefined || a.structured === null) {
    throw new Error(
      "Claude returned no structured output (was the JSON schema rejected?).",
    );
  }
  const parsed = opts.schema.safeParse(a.structured);
  if (!parsed.success) {
    throw new Error(
      `Claude's output did not match the schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
