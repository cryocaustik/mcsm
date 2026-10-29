import * as v from "valibot";
import { getModUpdates } from "../../../../utils/mods/updates";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const { refresh, loader } = await getValidatedQuery(
    event,
    v.parser(
      v.object({
        refresh: v.optional(v.picklist(["true", "false"]), "false"),
        loader: v.optional(
          v.picklist(["paper", "fabric", "forge", "neoforge"])
        ),
      })
    )
  );

  const { getServer } = useDocker(event);
  let server: Awaited<ReturnType<typeof getServer>>;
  try {
    server = await getServer(id);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "Server not found" });
  }

  const dir = jarsDir(server.config?.type);
  if (!dir) {
    throw createError({
      statusCode: 400,
      statusMessage: "This server type does not support mods or plugins",
    });
  }

  const resolvedLoader = await resolveServerLoader(server, loader);
  const gameVersion = await serverGameVersion(server.config);

  return getModUpdates(
    id,
    server,
    resolvedLoader,
    gameVersion,
    refresh === "true"
  );
});
