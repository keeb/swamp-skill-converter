import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { buildCatalog } from "../extensions/models/skill_converter/registry.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeRegistry(search: Record<string, unknown[]>, latest: Record<string, unknown>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/extensions/search") {
      const q = url.searchParams.get("q")!;
      if (q === "boom") return Promise.resolve(json({ error: "x" }, 500));
      return Promise.resolve(json({ extensions: search[q] ?? [] }));
    }
    const name = decodeURIComponent(url.pathname.split("/")[4]);
    return Promise.resolve(name in latest ? json(latest[name]) : json({}, 404));
  }) as typeof fetch;
}

Deno.test("buildCatalog merges, filters, ranks round-robin by query, and hydrates types", async () => {
  const fetcher = fakeRegistry({
    postgres: [
      { name: "@bob/postgres", pullCount: 50, contentTypes: ["models"] },
      { name: "@old/postgres", deprecatedAt: "2026-01-01", contentTypes: ["models"] },
      { name: "@vault/only", contentTypes: ["vaults"] },
    ],
    claude: [
      { name: "@swamp/claude", pullCount: 1, contentTypes: ["models"] },
      { name: "@bob/postgres", pullCount: 50, contentTypes: ["models"] },
    ],
  }, {
    "@bob/postgres": {
      latestVersionDetail: {
        models: [{
          type: "@bob/postgres",
          globalArguments: [{ name: "token", type: "string", required: true }],
          methods: [{ name: "listDumps", description: "List", arguments: [{ name: "state", type: "string" }] }],
        }],
        workflows: [{ name: "restore-drill" }],
      },
    },
  });

  const { extensions, failedQueries, truncated } = await buildCatalog("https://r.example", ["postgres", "claude", "boom"], {
    perQuery: 5,
    maxExtensions: 10,
    fetcher,
  });
  assertEquals(failedQueries, ["boom"]);
  assertEquals(truncated, false);
  // @bob/postgres is rank 0 for "postgres" and matched two queries, so it leads rank 0.
  assertEquals(extensions.map((e) => e.name), ["@bob/postgres", "@swamp/claude"]);
  const postgres = extensions[0];
  assertEquals(postgres.matchedQueries, ["claude", "postgres"]);
  assertEquals(postgres.workflows, ["restore-drill"]);
  assertEquals(postgres.types[0].methods[0], {
    name: "listDumps",
    description: "List",
    arguments: [{ name: "state", type: "string", required: false, description: "" }],
  });
  assertEquals(extensions[1].types, []);
});

Deno.test("buildCatalog gives every query its top hit before any query's tail", async () => {
  const many = (p: string) => Array.from({ length: 5 }, (_, i) => ({ name: `@${p}/x${i}`, contentTypes: ["models"] }));
  const { extensions, truncated } = await buildCatalog("https://r.example", ["a", "b"], {
    perQuery: 5,
    maxExtensions: 3,
    fetcher: fakeRegistry({ a: many("a"), b: many("b") }, {}),
  });
  assertEquals(extensions.map((e) => e.name).sort(), ["@a/x0", "@a/x1", "@b/x0"]);
  assertEquals(truncated, true);
});

Deno.test("buildCatalog throws when every query fails", async () => {
  await assertRejects(
    () => buildCatalog("https://r.example", ["boom"], { perQuery: 5, maxExtensions: 5, fetcher: fakeRegistry({}, {}) }),
    Error,
    "Every registry search failed",
  );
});
