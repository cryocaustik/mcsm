import {
  packMode,
  packPlatform,
  packVersion,
  newestPackVersion,
  packHasUpdate,
} from "../../../shared/utils/modpacks";
import type { H3Event } from "h3";
import {
  recordPackOperation as record,
  savePackOperation as saveOperation,
  beginPackOperation,
  findPackOperation,
} from "./state";
import type {
  ModpackStatus,
  PackOperation,
  ModpackMode,
} from "../../../shared/types/modpacks";
import { readInstalledPack, invalidateInstalledPack } from "./installed";
import {
  getPackCatalog,
  readCachedPackCatalog,
  setPackVersion,
} from "./catalog";
import { createBackup, restoreBackup } from "../backups";
import { recreateServer, buildServerSpec } from "../serverSpec";
import { invalidateLoaderCache } from "../minecraft/locations";
import { withRcon } from "../rcon";

const active = new Map<string, Promise<void>>();
const preparing = new Set<string>();
export async function getModpackStatus(
  event: H3Event,
  id: string,
  fresh = false
): Promise<ModpackStatus | null> {
  const docker = useDocker(event);
  const server = await docker.getServer(id).catch(async (error) => {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    return null;
  });
  if (!server) {
    const saved = await findPackOperation(id);
    const platform = packPlatform(saved?.previousConfig);
    if (!saved || !platform)
      throw createError({ statusCode: 404, statusMessage: "Server not found" });
    const catalog = await readCachedPackCatalog(saved.previousConfig).catch(
      () => null
    );
    let operation = saved.operation;
    if (
      !active.has(saved.volume) &&
      !["complete", "failed"].includes(operation.state)
    ) {
      operation = {
        ...operation,
        state: "failed",
        error:
          "Container recreation was interrupted. Restore the saved backup and configuration to recover.",
      };
      await saveOperation(saved.volume, operation);
    }
    return {
      containerAvailable: false,
      platform,
      mode: saved.operation.target === "latest" ? "latest" : "pinned",
      requestedVersion:
        saved.operation.target === "latest" ? null : saved.operation.target,
      installed: null,
      catalog,
      latest: catalog ? newestPackVersion(catalog.versions) : null,
      updateAvailable: false,
      ready: false,
      operation: publicOperation(operation),
      warnings: [
        "The server container is unavailable. The saved configuration and pre-update backup remain available for recovery.",
      ],
    };
  }
  const platform = packPlatform(server.config);
  if (!platform || !server.config) return null;
  const warnings: string[] = [];
  const installed = await readInstalledPack(id, server.config, fresh).catch(
    () => {
      warnings.push(
        "The container's modpack manifest could not be read. Installation may still be in progress."
      );
      return null;
    }
  );
  const [catalog, saved, info] = await Promise.all([
    readCachedPackCatalog(server.config, installed).catch((error) => {
      warnings.push(
        error.statusMessage ?? "Modpack version checks are unavailable."
      );
      return null;
    }),
    server.volume ? record(server.volume) : null,
    docker.docker.getContainer(id).inspect(),
  ]);
  let ready = Boolean(
    server.running &&
    installed?.receipt &&
    info.State?.Health?.Status === "healthy"
  );
  if (server.running && installed?.receipt && !info.State?.Health) {
    ready = await withRcon(event, id, async (rcon) => {
      await rcon.send("list");
      return true;
    }).catch(() => false);
  }
  let operation = saved?.operation ?? null;
  if (operation && !active.has(server.volume ?? "")) {
    if (
      operation.state === "backing-up" ||
      operation.state === "recreating" ||
      operation.state === "restoring"
    ) {
      const matches =
        operation.target === "latest" ||
        installed?.versionId === operation.target;
      const recreated =
        operation.state === "recreating" &&
        Date.parse(info.Created ?? "") >= operation.startedAt;
      operation =
        recreated && ready && matches
          ? { ...operation, state: "complete" }
          : recreated
            ? { ...operation, state: "installing" }
            : {
                ...operation,
                state: "failed",
                error:
                  "MCSM restarted before this operation completed. The saved backup is available for recovery.",
              };
      if (server.volume) await saveOperation(server.volume, operation);
    } else if (operation.state === "installing") {
      if (
        ready &&
        (operation.target === "latest" ||
          installed?.versionId === operation.target)
      ) {
        operation = { ...operation, state: "complete" };
        if (server.volume) await saveOperation(server.volume, operation);
      } else if (ready && operation.target !== "latest") {
        const confirmed = await readInstalledPack(
          id,
          server.config,
          true
        ).catch(() => null);
        if (confirmed?.receipt && confirmed.versionId !== operation.target) {
          operation = {
            ...operation,
            state: "failed",
            error:
              "The container is ready, but its recorded pack version does not match the requested version. Check Console and version selector overrides.",
          };
          if (server.volume) await saveOperation(server.volume, operation);
        }
      } else if (info.State?.Status === "exited" && info.State.ExitCode !== 0) {
        operation = {
          ...operation,
          state: "failed",
          error:
            "The container exited before the target modpack was ready. Check Console for installer output.",
        };
        if (server.volume) await saveOperation(server.volume, operation);
      }
    }
  }
  const latest = catalog ? newestPackVersion(catalog.versions) : null;
  return {
    containerAvailable: true,
    platform,
    mode: packMode(server.config),
    requestedVersion: packVersion(server.config),
    installed,
    catalog,
    latest,
    updateAvailable: Boolean(
      catalog && packHasUpdate(installed, latest, catalog.versions)
    ),
    ready,
    operation: operation ? publicOperation(operation) : null,
    warnings,
  };
}

type PackSelection = {
  versionId?: string;
  mode?: ModpackMode;
  rollback?: boolean;
};
export async function changeModpack(
  event: H3Event,
  id: string,
  selection: PackSelection
) {
  if (selection.rollback) await ensureRollbackContainer(event, id);
  const server = await useDocker(event).getServer(id);
  const key = server.volume ?? id;
  if (preparing.has(key) || active.has(key))
    throw createError({
      statusCode: 409,
      statusMessage: "A modpack change is already in progress",
    });
  preparing.add(key);
  try {
    return await prepareChange(event, id, selection);
  } finally {
    preparing.delete(key);
  }
}
async function prepareChange(
  event: H3Event,
  id: string,
  selection: PackSelection
) {
  const docker = useDocker(event);
  const server = await docker.getServer(id);
  const platform = packPlatform(server.config);
  if (!server.volume || !server.config || !platform)
    throw createError({
      statusCode: 400,
      statusMessage: "This server does not use a modpack",
    });
  const volume = server.volume;
  const previous = await record(volume);
  if (
    active.has(volume) ||
    (previous?.operation.state === "installing" && !selection.rollback)
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        "A modpack change is already in progress. Wait for installation to finish.",
    });
  const installed = await readInstalledPack(id, server.config, true).catch(
    (error) => {
      if (selection.rollback) return null;
      throw error;
    }
  );
  if (!installed?.receipt && !selection.rollback)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Wait for the current modpack installation to finish before changing versions.",
    });
  let config = server.config;
  let target: string;
  if (selection.rollback) {
    if (!previous?.operation.backupId)
      throw createError({
        statusCode: 409,
        statusMessage: "No pre-update backup is available",
      });
    config = previous.previousConfig;
    target = packVersion(config) ?? "";
    if (!target)
      throw createError({
        statusCode: 409,
        statusMessage: "The previous installed version could not be determined",
      });
  } else {
    const catalog = await getPackCatalog(config, installed, true);
    const version =
      selection.mode === "latest"
        ? (newestPackVersion(catalog.versions) ?? catalog.versions[0])
        : catalog.versions.find(
            (version) => version.id === selection.versionId
          );
    if (!version)
      throw createError({
        statusCode: 400,
        statusMessage: "Select a valid modpack version",
      });
    target = selection.mode === "latest" ? "latest" : version.id;
    config = setPackVersion(
      config,
      platform,
      target,
      selection.mode ?? "pinned"
    );
  }
  // Validate configuration and image availability before stopping the server.
  const spec = await buildServerSpec(config, event);
  await docker.ensureImage(spec.image);
  const previousConfig = installed
    ? setPackVersion(server.config, platform, installed.versionId, "pinned")
    : server.config;
  const operation: PackOperation & { volumeSource?: string } = {
    volumeSource: server.volumeSource ?? undefined,
    state: selection.rollback ? "restoring" : "backing-up",
    target,
    startedAt: Date.now(),
    ...(selection.rollback ? { backupId: previous!.operation.backupId } : {}),
  };
  await beginPackOperation(
    volume,
    id,
    selection.rollback ? previous!.previousConfig : previousConfig,
    operation
  );
  const run = (async () => {
    try {
      await docker.stopServer(id);
      if (selection.rollback)
        await restoreBackup(event, id, operation.backupId!);
      else {
        const backup = await createBackup(
          event,
          id,
          `Before modpack ${installed?.versionName ?? installed?.versionId} → ${target}`
        );
        operation.backupId = backup.id;
        await saveOperation(volume, operation);
      }
      operation.state = "recreating";
      await saveOperation(volume, operation);
      await recreateServer(
        event,
        id,
        config,
        `Modpack ${selection.rollback ? "rollback" : "version change"} requested: ${target}`
      );
      invalidateLoaderCache(volume);
      invalidateInstalledPack(id);
      operation.state = "installing";
      await saveOperation(volume, operation);
    } catch (error) {
      operation.state = "failed";
      operation.error =
        error instanceof Error ? error.message : "Modpack change failed";
      await saveOperation(volume, operation);
    }
  })();
  active.set(volume, run);
  void run
    .finally(() => {
      if (active.get(volume) === run) active.delete(volume);
    })
    .catch((error) =>
      console.error("[mcsm] Unable to record modpack operation", error)
    );
  event.waitUntil?.(run);
  return { accepted: true, operation: publicOperation(operation) };
}

function publicOperation(operation: PackOperation): PackOperation {
  return {
    state: operation.state,
    target: operation.target,
    startedAt: operation.startedAt,
    ...(operation.backupId ? { backupId: operation.backupId } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  };
}

/** Recreate a missing container without starting its installer before the restore. */
async function ensureRollbackContainer(event: H3Event, id: string) {
  const docker = useDocker(event);
  try {
    await docker.getServer(id);
    return;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  const saved = await findPackOperation(id);
  if (saved && (active.has(saved.volume) || preparing.has(saved.volume)))
    throw createError({
      statusCode: 409,
      statusMessage: "A modpack change is already in progress",
    });
  if (!saved?.operation.backupId || !saved.operation.volumeSource)
    throw createError({
      statusCode: 409,
      statusMessage: "No complete recovery record is available for this server",
    });
  const spec = await buildServerSpec(saved.previousConfig, event);
  await docker.provisionServer({
    name: id,
    image: spec.image,
    env: spec.env,
    labels: spec.labels,
    memoryBytes: spec.memoryBytes,
    port: spec.port,
    hostPort: spec.hostPort,
    voiceChat: spec.voiceChat,
    volume: saved.volume,
    volumeSource: saved.operation.volumeSource,
    restartPolicy: spec.restartPolicy,
    start: false,
  });
}
