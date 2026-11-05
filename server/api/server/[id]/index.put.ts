import { assertPackSelectionUnchanged } from "../../../utils/modpacks/catalog";
import { assertPackOperationIdle } from "../../../utils/modpacks/guard";
import * as v from "valibot";
import { serverConfigSchema } from "../../../schema/server.schema";

/**
 * Editing a server means recreating its container with the new config. Docker
 * can't mutate env/labels in place, so we remove the old container (keeping its
 * volume) and provision a fresh one reusing the same name and volume — the
 * world data is preserved.
 */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const data = await readValidatedBody(event, v.parser(serverConfigSchema));

  const existing = await useDocker(event).getServer(id);
  assertPackSelectionUnchanged(existing.config, data);
  await assertPackOperationIdle(existing);
  try {
    const result = await recreateServer(
      event,
      id,
      data,
      "Configuration saved — container recreated"
    );
    return { id: result.id, name: result.name, domain: result.domain };
  } catch (error) {
    if (isError(error) && error.statusCode === 409) throw error;
    console.error(error);
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to update server",
    });
  }
});
