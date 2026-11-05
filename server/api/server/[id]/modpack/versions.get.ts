import * as v from "valibot";
import { getPackCatalog } from "../../../../utils/modpacks/catalog";
import { readInstalledPack } from "../../../../utils/modpacks/installed";
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const { refresh } = await getValidatedQuery(
    event,
    v.parser(
      v.object({ refresh: v.optional(v.picklist(["true", "false"]), "false") })
    )
  );
  const server = await useDocker(event).getServer(id);
  if (!server.config)
    throw createError({
      statusCode: 400,
      statusMessage: "Server configuration unavailable",
    });
  const installed = await readInstalledPack(id, server.config).catch(
    () => null
  );
  return getPackCatalog(server.config, installed, refresh === "true");
});
