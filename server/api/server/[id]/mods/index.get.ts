import * as v from "valibot";
import { getModInventory } from "../../../../utils/mods/inventory";

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
  const server = await useDocker(event)
    .getServer(id)
    .catch(() => {
      throw createError({ statusCode: 404, statusMessage: "Server not found" });
    });
  return (await getModInventory(id, server, { fresh: refresh === "true" }))
    .inventory;
});
