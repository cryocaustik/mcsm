import { packPlatform } from "../../../shared/utils/modpacks";
import {
  assertPackOwnedFilesMutable as checkFiles,
  type PackServer,
} from "./installed";
import { recordPackOperation } from "./state";

/** Protect server-side mutation entry points throughout backup/install/restore. */
export async function assertPackFilesMutable(
  id: string,
  server: PackServer,
  filenames: string[]
) {
  await assertPackOperationIdle(server);
  await checkFiles(id, server, filenames);
}

/** Keep a stopped volume consistent while a pack backup or restore is running. */
export async function assertPackOperationIdle(
  server: Pick<PackServer, "config" | "volume">
) {
  if (!packPlatform(server.config)) return;
  const state = server.volume ? await recordPackOperation(server.volume) : null;
  if (state && !["complete", "failed"].includes(state.operation.state))
    throw createError({
      statusCode: 409,
      statusMessage:
        "A modpack change is in progress. Wait for it to finish before starting or changing the server.",
    });
}
