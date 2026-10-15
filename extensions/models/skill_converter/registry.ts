/**
 * Minimal read-only client for the swamp-club extension registry, used to
 * find existing extensions (and their model types, methods, and arguments)
 * that a skill's steps could map onto.
 *
 * @module
 */

/** An argument on a registry model type or method. */
export interface CatalogArg {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** A method on a registry model type. */
export interface CatalogMethod {
  name: string;
  description: string;
  arguments: CatalogArg[];
}

/** A model type published inside an extension. */
export interface CatalogType {
  type: string;
  globalArguments: CatalogArg[];
  methods: CatalogMethod[];
}

/** An extension candidate the plan may pull. */
export interface CatalogExtension {
  name: string;
  description: string;
  latestVersion: string;
  official: boolean;
  pullCount: number;
  scoreGrade: string | null;
  matchedQueries: string[];
  types: CatalogType[];
  workflows: string[];
}

interface SearchHit {
  name: string;
  description?: string;
  latestVersion?: string;
  pullCount?: number;
  deprecatedAt?: string | null;
  yankedAt?: string | null;
  isPrivate?: boolean;
  score?: { grade?: string } | null;
  contentTypes?: string[];
}

type Fetch = typeof fetch;

/** Trims long registry descriptions so the catalog stays prompt-sized. */
function clip(text: string | undefined, max: number): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// deno-lint-ignore no-explicit-any
function toArgs(raw: any): CatalogArg[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    name: String(a?.name ?? ""),
    type: String(a?.type ?? "unknown"),
    required: Boolean(a?.required),
    description: clip(a?.description, 200),
  })).filter((a) => a.name);
}

/** Searches the registry for one query. Deprecated, yanked and private hits are dropped. */
export async function searchRegistry(
  registryUrl: string,
  query: string,
  perPage: number,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ q: query, perPage: String(perPage) });
  const res = await fetcher(`${registryUrl}/api/v1/extensions/search?${qs}`, {
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `Registry search for "${query}" failed (HTTP ${res.status}): ${await res
        .text()}`,
    );
  }
  const body = await res.json() as { extensions?: SearchHit[] };
  return (body.extensions ?? []).filter((e) =>
    !e.deprecatedAt && !e.yankedAt && !e.isPrivate
  );
}

/** Fetches type/method metadata for an extension's latest version. */
export async function fetchExtensionTypes(
  registryUrl: string,
  name: string,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<
  { types: CatalogType[]; workflows: string[]; info: SearchHit | null }
> {
  const res = await fetcher(
    `${registryUrl}/api/v1/extensions/${encodeURIComponent(name)}/latest`,
    { signal },
  );
  if (res.status === 404) return { types: [], workflows: [], info: null };
  if (!res.ok) {
    throw new Error(
      `Registry lookup for ${name} failed (HTTP ${res.status}): ${await res
        .text()}`,
    );
  }
  // deno-lint-ignore no-explicit-any
  const body = await res.json() as any;
  const detail = body?.latestVersionDetail ?? {};
  const types: CatalogType[] =
    (Array.isArray(detail.models) ? detail.models : [])
      // deno-lint-ignore no-explicit-any
      .map((m: any) => ({
        type: String(m?.type ?? ""),
        globalArguments: toArgs(m?.globalArguments),
        methods: (Array.isArray(m?.methods) ? m.methods : [])
          // deno-lint-ignore no-explicit-any
          .map((x: any) => ({
            name: String(x?.name ?? ""),
            description: clip(x?.description, 240),
            arguments: toArgs(x?.arguments),
          }))
          .filter((x: CatalogMethod) => x.name),
      }))
      .filter((t: CatalogType) => t.type);
  const workflows = (Array.isArray(detail.workflows) ? detail.workflows : [])
    // deno-lint-ignore no-explicit-any
    .map((w: any) =>
      typeof w === "string" ? w : String(w?.name ?? w?.fileName ?? "")
    )
    .filter(Boolean);
  return { types, workflows, info: body?.name ? body as SearchHit : null };
}

/**
 * Runs every query, merges hits by extension name, picks up to
 * `maxExtensions` round-robin by each query's registry rank, and hydrates
 * them with type metadata.
 */
export async function buildCatalog(
  registryUrl: string,
  queries: string[],
  opts: {
    perQuery: number;
    maxExtensions: number;
    pinned?: string[];
    fetcher?: Fetch;
    signal?: AbortSignal;
  },
): Promise<
  {
    extensions: CatalogExtension[];
    failedQueries: string[];
    truncated: boolean;
  }
> {
  const fetcher = opts.fetcher ?? fetch;
  const perQueryHits: SearchHit[][] = [];
  const failedQueries: string[] = [];

  const results = await Promise.allSettled(
    queries.map((q) =>
      searchRegistry(registryUrl, q, opts.perQuery, fetcher, opts.signal)
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") failedQueries.push(queries[i]);
    perQueryHits.push(
      r.status === "fulfilled"
        ? r.value.filter((h) =>
          (h.contentTypes ?? ["models"]).some((c) =>
            c === "models" || c === "workflows"
          )
        )
        : [],
    );
  });
  if (queries.length > 0 && failedQueries.length === queries.length) {
    throw new Error(
      `Every registry search failed (${registryUrl}); is the registry reachable?`,
    );
  }

  // Which queries matched each extension (for the catalog and the prompt).
  const matched = new Map<string, Set<string>>();
  perQueryHits.forEach((hits, i) => {
    for (const h of hits) {
      matched.set(h.name, (matched.get(h.name) ?? new Set()).add(queries[i]));
    }
  });

  // Round-robin by registry rank so each query's best hits make the cut
  // before any query's long tail; ties within a rank go to extensions that
  // matched more queries, then official ones, then the most pulled.
  const chosen = new Map<string, SearchHit>();
  const depth = Math.max(0, ...perQueryHits.map((h) => h.length));
  for (let rank = 0; rank < depth && chosen.size < opts.maxExtensions; rank++) {
    const tier = perQueryHits.map((h) => h[rank]).filter((h): h is SearchHit =>
      !!h && !chosen.has(h.name)
    );
    tier.sort((a, b) =>
      (matched.get(b.name)!.size - matched.get(a.name)!.size) ||
      (Number(b.name.startsWith("@swamp/")) -
        Number(a.name.startsWith("@swamp/"))) ||
      ((b.pullCount ?? 0) - (a.pullCount ?? 0))
    );
    for (const h of tier) {
      if (chosen.size >= opts.maxExtensions) break;
      chosen.set(h.name, h);
    }
  }
  const ranked = [...chosen.values()].map((hit) => ({
    hit,
    queries: matched.get(hit.name)!,
  }));
  const truncated = matched.size > chosen.size;
  const pinned = (opts.pinned ?? []).filter((name) => !chosen.has(name));

  // Pinned extensions are always offered to the planner, outside the maxExtensions budget.
  const pinnedHits = (await Promise.all(pinned.map(async (name) => {
    const { info } = await fetchExtensionTypes(
      registryUrl,
      name,
      fetcher,
      opts.signal,
    )
      .catch(() => ({ info: null }));
    return info && !info.deprecatedAt && !info.yankedAt
      ? { hit: info, queries: new Set<string>() }
      : null;
  }))).filter((x): x is { hit: SearchHit; queries: Set<string> } => x !== null);

  const extensions = await Promise.all(
    [...ranked, ...pinnedHits].map(async ({ hit, queries }) => {
      const { types, workflows } = await fetchExtensionTypes(
        registryUrl,
        hit.name,
        fetcher,
        opts.signal,
      )
        .catch(() => ({
          types: [] as CatalogType[],
          workflows: [] as string[],
        }));
      return {
        name: hit.name,
        description: clip(hit.description, 600),
        latestVersion: hit.latestVersion ?? "",
        official: hit.name.startsWith("@swamp/"),
        pullCount: hit.pullCount ?? 0,
        scoreGrade: hit.score?.grade ?? null,
        matchedQueries: [...queries].sort(),
        types,
        workflows,
      };
    }),
  );
  return { extensions, failedQueries, truncated };
}
