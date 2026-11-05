import * as v from "valibot";
import { changeModpack } from "../../../../utils/modpacks/operations";
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const body = await readValidatedBody(
    event,
    v.parser(
      v.object({
        versionId: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(128))
        ),
        mode: v.optional(v.picklist(["pinned", "latest"])),
        rollback: v.optional(v.boolean(), false),
      })
    )
  );
  const result = await changeModpack(event, id, body);
  setResponseStatus(event, 202);
  return result;
});
