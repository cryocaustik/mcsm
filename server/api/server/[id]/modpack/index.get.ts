import * as v from "valibot";
import { getModpackStatus } from "../../../../utils/modpacks/operations";
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
  return getModpackStatus(event, id, refresh === "true");
});
