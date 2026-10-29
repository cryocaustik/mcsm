import type {
  InstalledMod,
  ModInstallFailure,
  ModIdentity,
  ModOrigin,
  ModProvider,
} from "../types/mods";

/** H3 errors and ofetch's parsed response wrap error data at different levels. */
export function modInstallFailure(
  error: unknown
): ModInstallFailure | undefined {
  const data = (
    error as {
      data?: { modFailure?: unknown; data?: { modFailure?: unknown } };
    } | null
  )?.data;
  const failure = (data?.data?.modFailure ?? data?.modFailure) as
    | Partial<ModInstallFailure>
    | undefined;
  if (
    failure &&
    typeof failure.message === "string" &&
    typeof failure.code === "string" &&
    typeof failure.retryable === "boolean" &&
    (failure.provider === "modrinth" || failure.provider === "curseforge")
  )
    return failure as ModInstallFailure;
}

export function modProjectKey(provider: ModProvider, projectId: string) {
  return `${provider}:${projectId}`;
}

export function modSourceLabel(source: ModOrigin): string {
  return {
    modrinth: "Modrinth",
    curseforge: "CurseForge",
    manual: "Manual upload",
    unknown: "Unknown",
  }[source];
}

/** Provider downloads link to their recorded source; uploads use a known listing. */
export function installedModLinkIdentity(
  mod: InstalledMod
): ModIdentity | undefined {
  if (mod.source === "modrinth" || mod.source === "curseforge") {
    return mod.identities.find((identity) => identity.provider === mod.source);
  }
  return mod.identities[0];
}

export function installedModKeys(mods: InstalledMod[]): Set<string> {
  return new Set(
    mods.flatMap((mod) =>
      mod.identities.map((identity) =>
        modProjectKey(identity.provider, identity.projectId)
      )
    )
  );
}

export function filterInstalledMods(
  mods: InstalledMod[],
  query: string,
  availableOn: "all" | "unknown" | ModProvider,
  source: "all" | ModOrigin = "all"
) {
  const term = query.trim().toLocaleLowerCase();
  return mods.filter((mod) => {
    const matchesListing =
      availableOn === "all" ||
      (availableOn === "unknown"
        ? mod.identities.length === 0
        : mod.identities.some((identity) => identity.provider === availableOn));
    const matchesSource = source === "all" || mod.source === source;
    const text = [
      mod.filename,
      ...mod.identities.flatMap((identity) => [
        identity.name,
        identity.version,
      ]),
    ].join(" ");
    return (
      matchesListing && matchesSource && text.toLocaleLowerCase().includes(term)
    );
  });
}
