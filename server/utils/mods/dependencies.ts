import type { InstalledMod } from "../../../shared/types/mods";
import { modProjectKey } from "../../../shared/utils/mods";
import type { ModOriginRecord } from "./origins";

/** Derive reverse links from current files, so deleted parents disappear immediately. */
export function attachModDependents(
  mods: InstalledMod[],
  origins: Record<string, ModOriginRecord>,
  hashes: Map<string, string>
): InstalledMod[] {
  const byProject = new Map<string, Set<string>>();
  const byHash = new Map<string, Set<string>>();
  const records = new Map<string, ModOriginRecord>();
  const dependents = new Map<
    string,
    Map<string, { filename: string; name: string }>
  >();
  function index(map: Map<string, Set<string>>, key: string, filename: string) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(filename);
  }
  for (const mod of mods) {
    const sha1 = hashes.get(mod.filename);
    const record = origins[mod.filename];
    if (record && sha1 && record.sha1 === sha1) {
      records.set(mod.filename, record);
      if (record.project)
        index(
          byProject,
          modProjectKey(record.project.provider, record.project.projectId),
          mod.filename
        );
    }
    for (const identity of mod.identities)
      index(
        byProject,
        modProjectKey(identity.provider, identity.projectId),
        mod.filename
      );
    if (sha1) index(byHash, sha1, mod.filename);
  }
  for (const mod of mods) {
    const record = records.get(mod.filename);
    const parent = {
      filename: mod.filename,
      name:
        mod.identities.find((identity) => identity.provider === mod.source)
          ?.name ??
        mod.identities[0]?.name ??
        mod.filename,
    };
    for (const dependency of record?.dependencies ?? []) {
      const targets =
        byProject.get(
          modProjectKey(dependency.provider, dependency.projectId)
        ) ?? (dependency.sha1 ? byHash.get(dependency.sha1) : undefined);
      for (const filename of targets ?? []) {
        if (filename === mod.filename) continue;
        if (!dependents.has(filename)) dependents.set(filename, new Map());
        dependents.get(filename)!.set(mod.filename, parent);
      }
    }
  }
  return mods.map((mod) => {
    const requiredBy = [...(dependents.get(mod.filename)?.values() ?? [])].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.filename.localeCompare(b.filename)
    );
    return {
      ...mod,
      dependency:
        records.get(mod.filename)?.dependency === true || requiredBy.length > 0,
      requiredBy,
    };
  });
}
