/**
 * Reads a Claude Code / Agent skill (a `SKILL.md` plus optional reference
 * files) from disk and extracts the structure the converter reasons over.
 *
 * @module
 */
import { parse as parseYaml } from "npm:yaml@2.9.1";

/** A supporting file shipped alongside a skill. */
export interface SkillFile {
  /** Path relative to the skill directory. */
  path: string;
  /** Full text content. */
  content: string;
}

/** A fenced code block found in the skill body. */
export interface CodeBlock {
  /** Info-string language tag (may be empty). */
  lang: string;
  /** Block body. */
  code: string;
}

/** The parsed representation of a skill. */
export interface ParsedSkill {
  /** Skill name from frontmatter, else the directory name. */
  name: string;
  /** Skill description from frontmatter (the trigger text). */
  description: string;
  /** Remaining frontmatter keys (allowed-tools, etc.). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter removed. */
  body: string;
  /** Section headings in document order. */
  headings: string[];
  /** Fenced code blocks from the body and reference files. */
  codeBlocks: CodeBlock[];
  /** CLI tools invoked from shell code blocks, deduplicated. */
  cliTools: string[];
  /** Hostnames referenced by URLs in the skill. */
  hosts: string[];
  /** Additional markdown reference files bundled with the skill. */
  references: SkillFile[];
  /** Non-markdown files bundled with the skill (scripts, templates), by path only. */
  assets: string[];
  /** Absolute path of the SKILL.md that was read. */
  sourcePath: string;
  /** SHA-256 of all text the converter consumed. */
  contentHash: string;
}

/** Hard cap on how much skill text is fed to the model. Exceeding it is an error, never a silent truncation. */
export const MAX_SKILL_BYTES = 400_000;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console"]);
// Words that start shell lines but aren't tools worth searching the registry for.
/** Commands too generic to search the registry for (shell builtins, coreutils, build drivers). */
export const SHELL_NOISE: ReadonlySet<string> = new Set([
  "cd",
  "echo",
  "export",
  "cat",
  "ls",
  "grep",
  "sed",
  "awk",
  "head",
  "tail",
  "if",
  "then",
  "else",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "set",
  "source",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "sudo",
  "env",
  "true",
  "false",
  "test",
  "jq",
  "xargs",
  "sort",
  "uniq",
  "wc",
  "tee",
  "printf",
  "read",
  "exit",
  "return",
  "local",
  "function",
  "case",
  "esac",
  "eval",
  "exec",
  "sleep",
  "find",
  "pwd",
  "which",
  "time",
  "cut",
  "tr",
  "diff",
  "make",
  "#",
  "$",
  ">",
  "<",
]);

/** Splits frontmatter from body. Missing or malformed frontmatter yields an empty map. */
export function splitFrontmatter(
  text: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(FRONTMATTER);
  if (!match) return { frontmatter: {}, body: text };
  const parsed = parseYaml(match[1]);
  const frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  return { frontmatter, body: text.slice(match[0].length) };
}

/** Extracts fenced code blocks (``` or ~~~). */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /^(```|~~~)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  for (const m of markdown.matchAll(fence)) {
    blocks.push({ lang: m[2].trim().split(/\s+/)[0] ?? "", code: m[3] });
  }
  return blocks;
}

/** Extracts ATX headings. */
export function extractHeadings(markdown: string): string[] {
  const withoutCode = markdown.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, "");
  return [...withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) =>
    m[1]
  );
}

/** Finds the leading command of each shell line, skipping builtins and noise. */
export function detectCliTools(blocks: CodeBlock[]): string[] {
  const tools = new Set<string>();
  for (const block of blocks) {
    if (!SHELL_LANGS.has(block.lang.toLowerCase())) continue;
    for (const raw of block.code.split("\n")) {
      // Each pipeline / && segment can start a new command.
      for (const segment of raw.split(/\|\||&&|\||;/)) {
        const words = segment.trim().replace(/^\$\s+/, "").split(/\s+/);
        // Skip leading VAR=value assignments.
        const cmd = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
        if (!cmd || !/^[a-z][a-z0-9._-]*$/.test(cmd)) continue;
        if (SHELL_NOISE.has(cmd)) continue;
        tools.add(cmd);
      }
    }
  }
  return [...tools].sort();
}

/** Collects hostnames from http(s) URLs. */
export function detectHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    hosts.add(m[1].toLowerCase());
  }
  return [...hosts].sort();
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      out.push(...await walk(`${dir}/${entry.name}`, relPath));
    } else if (entry.isFile) out.push(relPath);
  }
  return out.sort();
}

/** Builds a ParsedSkill from SKILL.md text plus reference files. Pure; no I/O. */
export async function buildParsedSkill(
  skillMd: string,
  opts: {
    sourcePath: string;
    fallbackName: string;
    references?: SkillFile[];
    assets?: string[];
  },
): Promise<ParsedSkill> {
  const references = opts.references ?? [];
  const { frontmatter, body } = splitFrontmatter(skillMd);
  const allText = [body, ...references.map((r) => r.content)].join("\n");
  const codeBlocks = [
    ...extractCodeBlocks(body),
    ...references.flatMap((r) => extractCodeBlocks(r.content)),
  ];
  const { name, description, ...rest } = frontmatter;
  return {
    name: typeof name === "string" && name ? name : opts.fallbackName,
    description: typeof description === "string" ? description : "",
    frontmatter: rest,
    body,
    headings: extractHeadings(body),
    codeBlocks,
    cliTools: detectCliTools(codeBlocks),
    hosts: detectHosts(allText),
    references,
    assets: opts.assets ?? [],
    sourcePath: opts.sourcePath,
    contentHash: await sha256(
      [skillMd, ...references.map((r) => `${r.path}\n${r.content}`)].join("\n"),
    ),
  };
}

/**
 * Reads a skill from disk. `path` may point at a SKILL.md file or at the
 * skill's directory; every other markdown file under that directory is
 * treated as a reference file.
 */
export async function readSkill(path: string): Promise<ParsedSkill> {
  const stat = await Deno.stat(path);
  const dir = stat.isDirectory ? path : path.replace(/\/[^/]+$/, "") || ".";
  const skillPath = stat.isDirectory ? `${path}/SKILL.md` : path;
  const skillMd = await Deno.readTextFile(skillPath);
  const skillFile = skillPath.slice(dir.length + 1);

  const references: SkillFile[] = [];
  const assets: string[] = [];
  // A bare SKILL.md path (not a directory) still picks up siblings only when
  // it is literally named SKILL.md; any other file is treated as standalone.
  const scanDir = stat.isDirectory || /(^|\/)SKILL\.md$/i.test(skillPath);
  if (scanDir) {
    for (const rel of await walk(dir)) {
      if (rel === skillFile) continue;
      if (/\.mdx?$/i.test(rel)) {
        references.push({
          path: rel,
          content: await Deno.readTextFile(`${dir}/${rel}`),
        });
      } else {
        assets.push(rel);
      }
    }
  }

  const total = new TextEncoder().encode(
    skillMd + references.map((r) => r.content).join(""),
  ).length;
  if (total > MAX_SKILL_BYTES) {
    throw new Error(
      `Skill at ${path} is ${total} bytes of markdown, over the ${MAX_SKILL_BYTES}-byte limit. ` +
        `Point 'path' at the SKILL.md file alone to skip reference files, or split the skill.`,
    );
  }

  const dirName = dir.split("/").filter(Boolean).pop() ?? "skill";
  return await buildParsedSkill(skillMd, {
    sourcePath: await Deno.realPath(skillPath),
    fallbackName: dirName,
    references,
    assets,
  });
}
