import type {
  ModIdentity,
  ModInventory,
  ModProvider,
} from "../../../shared/types/mods";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../../schema/server.schema";
import { listJars, invalidateJarList } from "../minecraft/jars";
import { jarsDir } from "../minecraft/locations";
import { parseModrinthProjects } from "../modrinth";
import { useSecrets } from "../secrets";
import { createCurseforgeSource } from "./curseforge";
import { modrinthSource } from "./modrinth";
import { scanModSignatures, invalidateModSignatures } from "./signatures";
import { identifyModFiles, invalidateModIdentities } from "./identification";
import type { ModFileSignature, ModSource } from "./types";
import {
  readModOrigins,
  recordedModSource,
  type ModOriginRecord,
} from "./origins";
import { attachModDependents } from "./dependencies";

export type ModServer = {
  id: string;
  volume?: string | null;
  config: ServerConfig | null;
  running: boolean;
};

export async function modSources(plugin = false) {
  const key = await useSecrets().get("CURSEFORGE_API_KEY");
  const sources: ModSource[] = [modrinthSource];
  if (key) sources.push(createCurseforgeSource(key, plugin));
  return {
    sources,
    curseforgeAvailable: Boolean(key),
    configuration: createHash("sha256")
      .update(key ?? "")
      .digest("hex"),
  };
}

export function invalidateModInventory(id: string) {
  invalidateModIdentities(id);
  invalidateModSignatures(id);
  invalidateJarList(id, "mods");
  invalidateJarList(id, "plugins");
}

export async function getModInventory(
  id: string,
  server: ModServer,
  options: { fresh?: boolean; strictProvider?: ModProvider } = {}
): Promise<{
  inventory: ModInventory;
  signatures: ModFileSignature[];
  sources: ModSource[];
  origins: Record<string, ModOriginRecord>;
}> {
  const dir = jarsDir(server.config?.type);
  if (!dir)
    throw createError({
      statusCode: 400,
      statusMessage: "This server type does not support mods or plugins",
    });
  const [files, { sources, curseforgeAvailable, configuration }] =
    await Promise.all([
      listJars(id, dir, {
        fresh: options.fresh || Boolean(options.strictProvider),
      }),
      modSources(dir === "plugins"),
    ]);
  const signatures = await scanModSignatures(id, dir, {
    files,
    fresh: options.fresh,
  });
  const identities: Record<string, ModIdentity[]> = {};
  const warnings: string[] = [];
  const results = await Promise.allSettled(
    sources.map((source) =>
      identifyModFiles(
        `${id}:${dir}:${source.id}:${source.id === "curseforge" ? configuration : ""}`,
        source,
        signatures,
        options.fresh
      )
    )
  );
  for (const [index, result] of results.entries()) {
    const source = sources[index]!;
    if (result.status === "rejected") {
      if (options.strictProvider === source.id) throw result.reason;
      warnings.push(
        `${source.id === "modrinth" ? "Modrinth" : "CurseForge"} identification is unavailable. Some files may show as unknown.`
      );
      continue;
    }
    for (const [filename, identity] of Object.entries(result.value))
      (identities[filename] ??= []).push(identity);
  }
  const managedTokens = new Set(
    parseModrinthProjects(server.config?.MODRINTH_PROJECTS).map((token) =>
      token.split(":")[0]!.toLowerCase()
    )
  );
  const origins = await readModOrigins(id, dir).catch(
    (): Record<string, ModOriginRecord> => {
      warnings.push(
        "Could not read mod tracking records. Installation sources and dependency relationships may be unavailable."
      );
      return {};
    }
  );
  const signaturesByName = new Map(
    signatures.map((signature) => [signature.filename, signature.sha1])
  );
  return {
    inventory: {
      mods: attachModDependents(
        files.map((file) => {
          const recognized = identities[file.name] ?? [];
          return {
            filename: file.name,
            size: file.size,
            modifiedAt: file.modifiedAt,
            source: recordedModSource(
              origins[file.name],
              signaturesByName.get(file.name)
            ),
            dependency: false,
            requiredBy: [],
            identities: recognized,
            managed: recognized.some(
              (identity) =>
                identity.provider === "modrinth" &&
                (managedTokens.has(identity.slug.toLowerCase()) ||
                  managedTokens.has(identity.projectId.toLowerCase()))
            ),
          };
        }),
        origins,
        signaturesByName
      ),
      warnings,
      providers: [
        { id: "modrinth", available: true },
        {
          id: "curseforge",
          available: curseforgeAvailable,
          ...(!curseforgeAvailable
            ? {
                reason:
                  "Ask an administrator to add a CurseForge API key in Admin → Secrets.",
              }
            : {}),
        },
      ],
    },
    signatures,
    sources,
    origins,
  };
}
