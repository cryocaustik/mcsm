import type {
  ModpackPlatform,
  ModpackMode,
  PackVersion,
  InstalledPack,
} from "../types/modpacks";
export type PackConfiguration = {
  type?: string | null;
  customEnv?: { key: string; value: string }[];
  MODPACK_UPDATE_MODE?: ModpackMode;
};

export function packEnv(config: PackConfiguration, key: string): string | null {
  const value = (config as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value
    ? value
    : config.customEnv?.find((entry) => entry.key.toUpperCase() === key)
        ?.value || null;
}
export function packPlatform(
  config?: PackConfiguration | null
): ModpackPlatform | null {
  if (!config) return null;
  const type =
    packEnv(config, "MODPACK_PLATFORM") ||
    packEnv(config, "MOD_PLATFORM") ||
    config.type;
  return (
    (
      {
        AUTO_CURSEFORGE: "curseforge",
        MODRINTH: "modrinth",
        FTBA: "ftb",
      } as Record<string, ModpackPlatform>
    )[(type ?? "").toUpperCase()] ?? null
  );
}
export function packVersion(config: PackConfiguration): string | null {
  switch (packPlatform(config)) {
    case "curseforge":
      return (
        packEnv(config, "CF_FILE_ID") ||
        packEnv(config, "CF_PAGE_URL")?.match(/\/files\/(\d+)/)?.[1] ||
        null
      );
    case "ftb":
      return packEnv(config, "FTB_MODPACK_VERSION_ID");
    case "modrinth":
      return (
        packEnv(config, "MODRINTH_VERSION") ||
        packEnv(config, "MODRINTH_VERSION_ID") ||
        packEnv(config, "MODRINTH_MODPACK")?.match(
          /\/version\/([^/?#]+)/
        )?.[1] ||
        null
      );
    default:
      return null;
  }
}
export function packMode(config: PackConfiguration): ModpackMode {
  return (
    config.MODPACK_UPDATE_MODE ?? (packVersion(config) ? "pinned" : "latest")
  );
}

export function newestPackVersion(versions: PackVersion[]) {
  return (
    [...versions]
      .filter((version) => version.channel === "release")
      .sort(
        (a, b) =>
          Date.parse(b.releasedAt ?? "") - Date.parse(a.releasedAt ?? "")
      )[0] ?? null
  );
}
export function packHasUpdate(
  installed: InstalledPack | null,
  latest: PackVersion | null,
  versions: PackVersion[]
) {
  if (!installed || !latest || installed.versionId === latest.id) return false;
  const current = versions.find(
    (version) => version.id === installed.versionId
  );
  return Boolean(
    current?.releasedAt &&
    latest.releasedAt &&
    Date.parse(latest.releasedAt) > Date.parse(current.releasedAt)
  );
}
