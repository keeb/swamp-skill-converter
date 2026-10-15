import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildParsedSkill,
  detectCliTools,
  detectHosts,
  extractCodeBlocks,
  extractHeadings,
  readSkill,
  splitFrontmatter,
} from "../extensions/models/skill_converter/skill.ts";

const FIXTURE = new URL("./fixtures/nightly-db-backup", import.meta.url).pathname;

Deno.test("splitFrontmatter separates YAML from body", () => {
  const { frontmatter, body } = splitFrontmatter("---\nname: x\ndescription: y\n---\n# Hi\n");
  assertEquals(frontmatter, { name: "x", description: "y" });
  assertEquals(body, "# Hi\n");
});

Deno.test("splitFrontmatter tolerates a missing block", () => {
  const { frontmatter, body } = splitFrontmatter("# Just a body");
  assertEquals(frontmatter, {});
  assertEquals(body, "# Just a body");
});

Deno.test("extractHeadings ignores # lines inside code fences", () => {
  const md = "# Title\n```bash\n# not a heading\n```\n## Step\n";
  assertEquals(extractHeadings(md), ["Title", "Step"]);
});

Deno.test("detectCliTools finds commands across pipes, && and $ prompts, skipping builtins and build tools", () => {
  const blocks = extractCodeBlocks(
    "```bash\n$ psql -c 'select 1' | jq .\naws s3 ls && aws s3 cp a b\nFOO=1 make test\necho hi\n```\n```python\nimport os\n```\n",
  );
  assertEquals(detectCliTools(blocks), ["aws", "psql"]);
});

Deno.test("detectHosts lowercases and dedupes", () => {
  assertEquals(detectHosts("see https://Hooks.Example.com/a and http://hooks.example.com/b"), ["hooks.example.com"]);
});

Deno.test("buildParsedSkill falls back to directory name and hashes content", async () => {
  const a = await buildParsedSkill("# body", { sourcePath: "/x/SKILL.md", fallbackName: "dir" });
  const b = await buildParsedSkill("# body!", { sourcePath: "/x/SKILL.md", fallbackName: "dir" });
  assertEquals(a.name, "dir");
  assert(a.contentHash !== b.contentHash);
});

Deno.test("readSkill reads a skill directory with references", async () => {
  const skill = await readSkill(FIXTURE);
  assertEquals(skill.name, "nightly-db-backup");
  assert(skill.description.startsWith("Use when"));
  assertEquals(skill.frontmatter["allowed-tools"], "Bash, Read");
  assertEquals(skill.references.map((r) => r.path), ["references/retention.md"]);
  assertEquals(skill.cliTools, ["aws", "pg_dump", "pg_restore"]);
  assertEquals(skill.hosts, ["hooks.example.com"]);
  assert(skill.headings.includes("3. Verify"));
});

Deno.test("readSkill accepts a SKILL.md path directly", async () => {
  const skill = await readSkill(`${FIXTURE}/SKILL.md`);
  assertEquals(skill.references.length, 1);
});

Deno.test("readSkill rejects a missing path", async () => {
  await assertRejects(() => readSkill(`${FIXTURE}/nope`), Deno.errors.NotFound);
});
