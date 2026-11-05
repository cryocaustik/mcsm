import type { ServerConfig } from "../../schema/server.schema";
import type {
  InstalledPack,
  PackCatalog,
  PackVersion,
  ModpackMode,
} from "../../../shared/types/modpacks";
import {
  packEnv,
  packMode,
  packPlatform,
  packVersion,
  newestPackVersion,
} from "../../../shared/utils/modpacks";
import { readModCache, writeModCache } from "../mods/cache";

type CFProject = {
  id: number;
  slug: string;
  name: string;
  logo?: { thumbnailUrl?: string };
  links?: { websiteUrl?: string };
};
type CFFile = {
  id: number;
  displayName: string;
  fileDate: string;
  releaseType: number;
  isServerPack?: boolean;
  gameVersions?: string[];
};
type MRProject = {
  id: string;
  slug: string;
  title: string;
  icon_url: string | null;
  project_type: string;
};
type MRVersion = {
  id: string;
  name: string;
  version_number: string;
  date_published: string;
  version_type: "release" | "beta" | "alpha";
  game_versions: string[];
  files: { filename: string }[];
};
type FTBVersion = {
  id: number;
  name: string;
  updated: number;
  released?: number;
  type: string;
  private?: boolean;
  targets?: { name: string; version: string; type: string }[];
};
type FTBProject = {
  id: number;
  name: string;
  slug?: string;
  status: string;
  versions: FTBVersion[];
  art?: { type: string; url: string }[];
};
const request = <T>(
  url: string,
  headers?: Record<string, string>,
  query?: Record<string, string | number>
) =>
  $fetch<T>(url, {
    headers: { "User-Agent": "MCSM (github.com/Niki2k1/mcsm)", ...headers },
    query,
    timeout: 10_000,
    retry: 0,
  });
const channel = (type: number | string): PackVersion["channel"] =>
  type === 2 || type === "beta"
    ? "beta"
    : type === 3 || type === "alpha"
      ? "alpha"
      : "release";
function modrinthReference(value: string) {
  if (!value.startsWith("http")) return value;
  const url = new URL(value);
  if (url.hostname !== "modrinth.com" || !url.pathname.startsWith("/modpack/"))
    throw new Error("Use a Modrinth modpack slug, ID or project URL.");
  return url.pathname.split("/")[2]!;
}
function catalogReference(
  config: ServerConfig,
  installed: InstalledPack | null
) {
  const platform = packPlatform(config);
  if (!platform)
    throw createError({
      statusCode: 400,
      statusMessage: "This server does not use a modpack",
    });
  const ref =
    platform === "curseforge"
      ? packEnv(config, "CF_SLUG") ||
        packEnv(config, "CF_PAGE_URL")?.match(
          /^https:\/\/(?:www\.)?curseforge\.com\/minecraft\/modpacks\/([^/]+)/
        )?.[1] ||
        installed?.slug ||
        installed?.projectId
      : platform === "modrinth"
        ? packEnv(config, "MODRINTH_MODPACK") ||
          packEnv(config, "MODRINTH_PROJECT") ||
          installed?.slug
        : packEnv(config, "FTB_MODPACK_ID") || installed?.projectId;
  if (!ref)
    throw createError({
      statusCode: 400,
      statusMessage: "The modpack project is not configured",
    });
  return { platform, ref, key: `${platform}:${ref}` };
}

export async function readCachedPackCatalog(
  config: ServerConfig,
  installed: InstalledPack | null = null
) {
  const { key } = catalogReference(config, installed);
  return (
    (await readModCache<{ at: number; catalog: PackCatalog }>("modpacks", key))
      ?.catalog ?? null
  );
}
export async function getPackCatalog(
  config: ServerConfig,
  installed: InstalledPack | null = null,
  fresh = false
): Promise<PackCatalog> {
  const { platform, ref, key } = catalogReference(config, installed);
  const saved = await readModCache<{ at: number; catalog: PackCatalog }>(
    "modpacks",
    key
  );
  if (!fresh && saved && Date.now() - saved.at < 10 * 60_000)
    return saved.catalog;
  try {
    let catalog: PackCatalog;
    if (platform === "curseforge") {
      const secret =
        (await useSecrets().get("CURSEFORGE_API_KEY")) || config.CF_API_KEY;
      if (!secret)
        throw new Error("Add a CurseForge API key in Admin → Secrets.");
      const headers = { "x-api-key": secret };
      const base = "https://api.curseforge.com/v1";
      let project: CFProject | undefined;
      if (/^\d+$/.test(ref))
        project = (
          await request<{ data: CFProject }>(`${base}/mods/${ref}`, headers)
        ).data;
      else if (installed?.slug === ref && installed.projectId)
        project = (
          await request<{ data: CFProject }>(
            `${base}/mods/${encodeURIComponent(installed.projectId)}`,
            headers
          )
        ).data;
      else
        project = (
          await request<{ data: CFProject[] }>(`${base}/mods/search`, headers, {
            gameId: 432,
            classId: 4471,
            slug: ref,
          })
        ).data.find((project) => project.slug === ref);
      if (!project) throw new Error("CurseForge modpack not found");
      const files: CFFile[] = [];
      for (let index = 0; index < 250; index += 50) {
        const page = await request<{ data: CFFile[] }>(
          `${base}/mods/${project.id}/files`,
          headers,
          { index, pageSize: 50 }
        );
        files.push(...page.data);
        if (page.data.length < 50) break;
      }
      for (const id of new Set(
        [installed?.versionId, packVersion(config)].filter((id): id is string =>
          Boolean(id && /^\d+$/.test(id))
        )
      )) {
        if (!files.some((file) => String(file.id) === id))
          files.push(
            (
              await request<{ data: CFFile }>(
                `${base}/mods/${project.id}/files/${id}`,
                headers
              )
            ).data
          );
      }
      catalog = {
        platform,
        id: String(project.id),
        slug: project.slug,
        name: project.name,
        url: `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(project.slug)}`,
        iconUrl: project.logo?.thumbnailUrl ?? null,
        versions: files
          .filter((file) => !file.isServerPack)
          .map((file) => ({
            id: String(file.id),
            name: file.displayName,
            releasedAt: file.fileDate,
            channel: channel(file.releaseType),
            minecraft: (file.gameVersions ?? []).filter((value) =>
              /^\d+\.\d+/.test(value)
            ),
          })),
      };
    } else if (platform === "modrinth") {
      const project = await request<MRProject>(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(modrinthReference(ref))}`
      );
      if (project.project_type !== "modpack")
        throw new Error("The selected Modrinth project is not a modpack");
      const versions = await request<MRVersion[]>(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(project.id)}/version`
      );
      catalog = {
        platform,
        id: project.id,
        slug: project.slug,
        name: project.title,
        url: `https://modrinth.com/modpack/${encodeURIComponent(project.slug)}`,
        iconUrl: project.icon_url,
        versions: versions
          .filter((version) =>
            version.files.some((file) => file.filename.endsWith(".mrpack"))
          )
          .map((version) => ({
            id: version.id,
            name: version.name || version.version_number,
            versionNumber: version.version_number,
            releasedAt: version.date_published,
            channel: channel(version.version_type),
            minecraft: version.game_versions,
          })),
      };
    } else {
      if (!/^\d+$/.test(ref))
        throw new Error("FTB requires a numeric modpack ID");
      const project = await request<FTBProject>(
        `https://api.feed-the-beast.com/v1/modpacks/public/modpack/${ref}`
      );
      if (project.status !== "success" || !Array.isArray(project.versions))
        throw new Error("FTB modpack not found");
      catalog = {
        platform,
        id: String(project.id),
        slug: project.slug ?? ref,
        name: project.name,
        url: `https://www.feed-the-beast.com/modpacks/${project.id}`,
        iconUrl: project.art?.find((art) => art.type === "square")?.url ?? null,
        versions: project.versions
          .filter((version) => !version.private)
          .map((version) => ({
            id: String(version.id),
            name: version.name,
            releasedAt: new Date(
              (version.released || version.updated) * 1000
            ).toISOString(),
            channel: channel(version.type),
            minecraft:
              version.targets
                ?.filter((target) => target.name === "minecraft")
                .map((target) => target.version) ?? [],
          })),
      };
    }
    catalog.versions.sort(
      (a, b) => Date.parse(b.releasedAt ?? "") - Date.parse(a.releasedAt ?? "")
    );
    await writeModCache("modpacks", key, { at: Date.now(), catalog });
    return catalog;
  } catch (error) {
    if (!fresh && saved) return saved.catalog;
    throw createError({
      statusCode: 502,
      statusMessage:
        error instanceof Error
          ? error.message
          : "The modpack provider is unavailable",
    });
  }
}
export function setPackVersion(
  config: ServerConfig,
  platform: PackCatalog["platform"],
  versionId: string | null,
  mode: ModpackMode
): ServerConfig {
  const selectors =
    platform === "curseforge"
      ? ["CF_FILE_ID", "CF_FILENAME_MATCHER", "CF_PAGE_URL"]
      : platform === "modrinth"
        ? ["MODRINTH_VERSION", "MODRINTH_VERSION_ID"]
        : ["FTB_MODPACK_VERSION_ID"];
  const cfSlug =
    config.CF_SLUG ||
    packEnv(config, "CF_PAGE_URL")?.match(
      /^https:\/\/(?:www\.)?curseforge\.com\/minecraft\/modpacks\/([^/]+)/
    )?.[1];
  const mrRef =
    packEnv(config, "MODRINTH_MODPACK") || packEnv(config, "MODRINTH_PROJECT");
  return {
    ...config,
    MODPACK_UPDATE_MODE: mode,
    customEnv: config.customEnv?.filter(
      (entry) =>
        !selectors.includes(entry.key.toUpperCase()) ||
        (entry.key.toUpperCase() === "CF_PAGE_URL" && !cfSlug)
    ),
    ...(platform === "curseforge"
      ? {
          CF_FILE_ID: mode === "pinned" ? versionId : null,
          ...(cfSlug ? { CF_SLUG: cfSlug } : {}),
        }
      : platform === "ftb"
        ? { FTB_MODPACK_VERSION_ID: mode === "pinned" ? versionId : null }
        : {
            MODRINTH_VERSION: mode === "pinned" ? versionId : null,
            ...(mrRef ? { MODRINTH_MODPACK: modrinthReference(mrRef) } : {}),
          }),
  };
}
/** Resolve a new pin once; the container still downloads and installs the pack. */
export async function resolvePackConfiguration(
  config: ServerConfig
): Promise<ServerConfig> {
  const platform = packPlatform(config);
  if (!platform || config.MODPACK_UPDATE_MODE === undefined) return config;
  if (packMode(config) === "latest")
    return setPackVersion(config, platform, null, "latest");
  const catalog = await getPackCatalog(config);
  const selected = packVersion(config);
  const version = selected
    ? catalog.versions.find(
        (version) =>
          version.id === selected ||
          version.name === selected ||
          version.versionNumber === selected
      )
    : newestPackVersion(catalog.versions);
  if (!version)
    throw createError({
      statusCode: 400,
      statusMessage: "Select a valid modpack version",
    });
  return setPackVersion(config, platform, version.id, "pinned");
}

/** Pack selection changes go through the backup/version workflow, not ordinary config saves. */
export function assertPackSelectionUnchanged(
  previous: ServerConfig | null,
  next: ServerConfig
) {
  const selection = (config: ServerConfig | null) => {
    const platform = packPlatform(config);
    if (!platform || !config) return null;
    const project =
      platform === "curseforge"
        ? packEnv(config, "CF_SLUG") ||
          packEnv(config, "CF_PAGE_URL")?.match(/\/modpacks\/([^/]+)/)?.[1]
        : platform === "ftb"
          ? packEnv(config, "FTB_MODPACK_ID")
          : modrinthReference(
              packEnv(config, "MODRINTH_MODPACK") ||
                packEnv(config, "MODRINTH_PROJECT") ||
                ""
            );
    return [platform, project, packVersion(config), packMode(config)];
  };
  if (JSON.stringify(selection(previous)) !== JSON.stringify(selection(next)))
    throw createError({
      statusCode: 409,
      statusMessage:
        "Manage modpack versions and update policy from Mods & Plugins. Create a new server to switch modpack projects.",
    });
}
