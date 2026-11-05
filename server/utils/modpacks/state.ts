import { eq } from "drizzle-orm";
import { db } from "@nuxthub/db";
import { modpackOperations } from "../../db/schema";
import type { PackOperation } from "../../../shared/types/modpacks";
import type { ServerConfig } from "../../schema/server.schema";

export async function recordPackOperation(volume: string) {
  return (
    await db
      .select()
      .from(modpackOperations)
      .where(eq(modpackOperations.volume, volume))
      .limit(1)
  )[0];
}
export async function savePackOperation(
  volume: string,
  operation: PackOperation
) {
  await db
    .update(modpackOperations)
    .set({ operation })
    .where(eq(modpackOperations.volume, volume));
}
export async function beginPackOperation(
  volume: string,
  serverId: string,
  previousConfig: ServerConfig,
  operation: PackOperation
) {
  await db
    .insert(modpackOperations)
    .values({ volume, serverId, previousConfig, operation })
    .onConflictDoUpdate({
      target: modpackOperations.volume,
      set: { serverId, previousConfig, operation },
    });
}

export async function findPackOperation(serverId: string) {
  return (
    await db
      .select()
      .from(modpackOperations)
      .where(eq(modpackOperations.serverId, serverId))
      .limit(1)
  )[0];
}
