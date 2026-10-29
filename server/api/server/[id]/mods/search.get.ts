import * as v from "valibot";
import { modSources } from "../../../../utils/mods/inventory";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const { provider, query, offset, sort, loader } = await getValidatedQuery(
    event,
    v.parser(
      v.object({
        provider: v.picklist(["modrinth", "curseforge"]),
        query: v.pipe(v.string(), v.maxLength(200)),
        offset: v.optional(
          v.pipe(
            v.string(),
            v.toNumber(),
            v.integer(),
            v.minValue(0),
            v.maxValue(10000)
          ),
          "0"
        ),
        sort: v.optional(
          v.picklist(["relevance", "downloads", "updated", "newest"]),
          "relevance"
        ),
        loader: v.optional(
          v.picklist(["paper", "fabric", "forge", "neoforge"])
        ),
      })
    )
  );
  const server = await useDocker(event)
    .getServer(id)
    .catch(() => {
      throw createError({ statusCode: 404, statusMessage: "Server not found" });
    });
  const dir = jarsDir(server.config?.type);
  if (!dir)
    throw createError({
      statusCode: 400,
      statusMessage: "This server type does not support mods or plugins",
    });
  const { sources } = await modSources(dir === "plugins");
  const source = sources.find((source) => source.id === provider);
  if (!source)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Ask an administrator to add a CurseForge API key in Admin → Secrets.",
    });
  const resolvedLoader = await resolveServerLoader(
    server,
    server.config?.type === "AUTO_CURSEFORGE" ? loader : undefined
  );
  const gameVersion = await serverGameVersion(server.config);
  const result = await source.search({
    query: query.trim(),
    loader: resolvedLoader,
    gameVersion,
    offset,
    sort,
  });
  return { ...result, offset, loader: resolvedLoader, gameVersion };
});
