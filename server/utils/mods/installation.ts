import * as v from "valibot";
import type { H3Event } from "h3";
import { randomUUID } from "node:crypto";
import type { ModInstallStage, ModProvider } from "../../../shared/types/mods";
import { reportModInstallFailure } from "./errors";
import { downloadModPlan, planModInstall, withModInstallLock } from "./install";
import { getModInventory } from "./inventory";
import { writeJarOrigin } from "../minecraft/jars";
import type { ModInstallResult } from "../../../shared/types/mod-list";

export async function installServerMod(
  event: H3Event,
  legacyProvider?: ModProvider
): Promise<ModInstallResult> {
  const { id } = await getValidatedRouterParams(
    event,
    v.parser(v.object({ id: v.string() }))
  );
  const {
    provider,
    project,
    loader,
    restart,
    versionId,
    skipInstalled,
    dependency,
  } = await readValidatedBody(
    event,
    v.parser(
      v.object({
        provider: legacyProvider
          ? v.optional(v.literal(legacyProvider), legacyProvider)
          : v.picklist(["modrinth", "curseforge"]),
        project: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        loader: v.optional(
          v.picklist(["paper", "fabric", "forge", "neoforge"])
        ),
        restart: v.optional(v.boolean(), true),
        versionId: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(128))
        ),
        skipInstalled: v.optional(v.boolean(), false),
        dependency: v.optional(v.boolean(), false),
      })
    )
  );
  const { getServer, restartServer } = useDocker(event);
  const server = await getServer(id).catch(() => {
    throw createError({ statusCode: 404, statusMessage: "Server not found" });
  });
  const dir = jarsDir(server.config?.type);
  if (!dir)
    throw createError({
      statusCode: 400,
      statusMessage: "This server type does not support mods or plugins",
    });
  const requestId = randomUUID();
  let stage: ModInstallStage = "identify";
  try {
    return await withModInstallLock(server.volume ?? id, async () => {
      const { inventory, signatures, sources, origins } = await getModInventory(
        id,
        server,
        { strictProvider: provider }
      );
      const source = sources.find((source) => source.id === provider);
      if (!source)
        throw createError({
          statusCode: 409,
          statusMessage:
            "Ask an administrator to add a CurseForge API key in Admin → Secrets.",
        });
      stage = "resolve";
      const resolvedLoader = await resolveServerLoader(
        server,
        server.config?.type === "AUTO_CURSEFORGE" ? loader : undefined
      );
      const gameVersion = await serverGameVersion(server.config);
      const plan = await planModInstall(
        source,
        project,
        resolvedLoader,
        gameVersion,
        inventory.mods,
        signatures,
        { versionId, skipInstalled }
      );
      stage = "download";
      const { jars, added } = await downloadModPlan(
        plan,
        signatures,
        provider,
        inventory.mods.map((mod) => mod.filename),
        { rootDependency: dependency }
      );
      stage = "write";
      if (jars.length) await writeJars(id, dir, jars, provider);
      const root = plan[0]!;
      for (const retainedVersion of plan) {
        if (!retainedVersion.installedFilename) continue;
        const retained = inventory.mods.find(
          (mod) => mod.filename === retainedVersion.installedFilename
        )!;
        const sha1 = signatures.find(
          (file) => file.filename === retained.filename
        )?.sha1;
        if (!sha1)
          throw createError({
            statusCode: 409,
            statusMessage:
              "Could not verify the installed mod. Refresh before importing it again.",
          });
        const previous = origins[retained.filename];
        const valid = previous?.sha1 === sha1 ? previous : undefined;
        await writeJarOrigin(id, {
          version: 1,
          directory: dir,
          filename: retained.filename,
          sha1,
          source: retained.source,
          project: valid?.project ?? {
            provider,
            projectId: retainedVersion.projectId,
          },
          dependencies: retainedVersion.resolvedDependencies,
          dependency: valid?.dependency === true,
        });
      }
      if (jars.length)
        await recordActivity(
          server.volume,
          "jars-uploaded",
          jars.map((jar) => jar.name).join(", ")
        );
      let restarted = false;
      if (restart && jars.length && server.running) {
        try {
          await restartServer(id);
          restarted = true;
        } catch (error) {
          console.error("[mcsm] Restart after mod install failed", error);
        }
      }
      return {
        added,
        restarted,
        alreadyInstalled: Boolean(root.installedFilename),
      };
    });
  } catch (error) {
    throw reportModInstallFailure(error, {
      provider,
      projectId: project,
      stage,
      requestId,
      serverId: id,
    });
  }
}
