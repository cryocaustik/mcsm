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
import {
  cachedModIdentities,
  identifyModFiles,
  invalidateModIdentities,
  modIdentitiesRefreshing,
} from "./identification";
import type { ModFileSignature, ModSource } from "./types";
import {
  readModOrigins,
  recordedModSource,
  type ModOriginRecord,
} from "./origins";
import { attachModDependents } from "./dependencies";
import { readInstalledPack } from "../modpacks/installed";
import { packVersion } from "../../../shared/utils/modpacks";
import { validModIdentity } from "./cache";

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

const pendingInventories = new Map<
  string,
  ReturnType<typeof buildModInventory>
>();

/** The list and update badge requests share one inventory build, even on force refresh. */
export async function getModInventory(
  id: string,
  server: ModServer,
  options: { fresh?: boolean; strictProvider?: ModProvider } = {}
) {
  const key = `${id}:${JSON.stringify([
    server.volume,
    server.config?.type,
    server.config?.MODRINTH_PROJECTS,
    server.config ? packVersion(server.config) : null,
    server.config?.MODRINTH_MODPACK,
    Boolean(options.fresh),
    options.strictProvider,
  ])}`;
  let pending = pendingInventories.get(key);
  if (!pending) {
    pending = buildModInventory(id, server, options);
    pendingInventories.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingInventories.get(key) === pending) pendingInventories.delete(key);
  }
}

export function invalidateModInventory(id: string) {
  for (const key of pendingInventories.keys())
    if (key.startsWith(`${id}:`)) pendingInventories.delete(key);
  invalidateModIdentities(id);
  invalidateModSignatures(id);
  invalidateJarList(id, "mods");
  invalidateJarList(id, "plugins");
}

async function buildModInventory(
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
  const warnings: string[] = [];
  const [files, { sources, curseforgeAvailable, configuration }, origins] =
    await Promise.all([
      listJars(id, dir, {
        fresh: options.fresh || Boolean(options.strictProvider),
      }),
      modSources(dir === "plugins"),
      readModOrigins(id, dir).catch((): Record<string, ModOriginRecord> => {
        warnings.push(
          "Could not read mod tracking records. Installation sources and dependency relationships may be unavailable."
        );
        return {};
      }),
    ]);
  const signatures = await scanModSignatures(id, dir, {
    files,
    fresh: options.fresh,
  });
  const pack = await readInstalledPack(id, server.config).catch(() => {
    warnings.push(
      "Modpack ownership could not be read. Pack file changes remain protected."
    );
    return null;
  });
  const packFiles = new Set(pack?.files ?? []);
  const identities: Record<string, ModIdentity[]> = {};
  const providerKey = (source: ModSource) =>
    `${id}:${dir}:${source.id}:${source.id === "curseforge" ? configuration : ""}`;
  const seeds: Record<string, ModIdentity> = Object.create(null);
  for (const signature of signatures) {
    const origin = origins[signature.filename];
    if (origin?.sha1 === signature.sha1 && validModIdentity(origin.identity)) {
      seeds[signature.filename] = origin.identity;
      identities[signature.filename] = [origin.identity];
    }
  }
  const cached = await Promise.all(
    sources.map((source) =>
      cachedModIdentities(providerKey(source), source, signatures, seeds)
    )
  );
  const known = new Set([
    ...Object.keys(seeds),
    ...cached.flatMap((matches) => Object.keys(matches)),
  ]);
  const results = await Promise.allSettled(
    sources.map((source) =>
      identifyModFiles(
        providerKey(source),
        source,
        signatures,
        options.fresh,
        options.strictProvider ? new Set() : known
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
    for (const [filename, identity] of Object.entries(result.value)) {
      const matches = (identities[filename] ??= []);
      const previous = matches.findIndex(
        (match) => match.provider === identity.provider
      );
      if (previous < 0) matches.push(identity);
      else matches[previous] = identity;
    }
  }
  const managedTokens = new Set(
    parseModrinthProjects(server.config?.MODRINTH_PROJECTS).map((token) =>
      token.split(":")[0]!.toLowerCase()
    )
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
            packManaged: packFiles.has(`${dir}/${file.name}`),
            ...(pack ? { packPlatform: pack.platform } : {}),
            managed:
              packFiles.has(`${dir}/${file.name}`) ||
              recognized.some(
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
      refreshing: sources.some((source) =>
        modIdentitiesRefreshing(providerKey(source), signatures)
      ),
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
