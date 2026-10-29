import type { InstalledMod, ModProvider } from "../../../shared/types/mods";
import { installedModKeys, modProjectKey } from "../../../shared/utils/mods";
import { downloadModFile } from "./download";
import type {
  ModFileSignature,
  ModSource,
  ModVersion,
  PlannedModVersion,
  ModProjectReference,
} from "./types";
import type { JarFile } from "../minecraft/jars";

const installing = new Set<string>();

export async function withModInstallLock<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  if (installing.has(key))
    throw createError({
      statusCode: 409,
      statusMessage:
        "Another mod installation is in progress. Try again shortly.",
    });
  installing.add(key);
  try {
    return await run();
  } finally {
    installing.delete(key);
  }
}

/** Resolve the entire dependency graph before any files are downloaded/written. */
export async function planModInstall(
  source: ModSource,
  projectId: string,
  loader: string,
  gameVersion: string,
  installed: InstalledMod[],
  signatures: ModFileSignature[] = [],
  options: { versionId?: string; skipInstalled?: boolean } = {}
): Promise<PlannedModVersion[]> {
  const installedKeys = installedModKeys(installed);
  const findInstalled = (id: string) =>
    installed.find((mod) =>
      mod.identities.some(
        (identity) =>
          identity.provider === source.id && identity.projectId === id
      )
    );
  let retained = findInstalled(projectId);
  if (
    !options.skipInstalled &&
    installedKeys.has(modProjectKey(source.id, projectId))
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        "This project is already installed. Use its update action to change versions.",
    });
  const retainedVersion = retained?.identities.find(
    (identity) =>
      identity.provider === source.id && identity.projectId === projectId
  )?.versionId;
  if (
    options.versionId &&
    retainedVersion &&
    options.versionId !== retainedVersion
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        "A different version of this mod is already installed. Use its update action or remove it before importing the listed version.",
    });
  const root = await source.resolve(
    projectId,
    loader,
    gameVersion,
    options.versionId ?? (options.skipInstalled ? retainedVersion : undefined)
  );
  if (!root)
    throw createError({
      statusCode: 404,
      statusMessage: `No compatible build for ${loader} ${gameVersion}`,
    });
  if (
    !options.skipInstalled &&
    installedKeys.has(modProjectKey(source.id, root.projectId))
  )
    throw createError({
      statusCode: 409,
      statusMessage: "This project is already installed",
    });
  if (options.skipInstalled) {
    retained ??= findInstalled(root.projectId);
    if (!retained) {
      const sameFile = signatures.find((file) => file.sha1 === root.sha1);
      retained = installed.find((mod) => mod.filename === sameFile?.filename);
    }
    const presentVersion = retained?.identities.find(
      (identity) =>
        identity.provider === source.id && identity.projectId === root.projectId
    )?.versionId;
    if (presentVersion && presentVersion !== root.versionId)
      throw createError({
        statusCode: 409,
        statusMessage:
          "A different version of this mod is already installed. Use its update action to change versions.",
      });
  }
  const planned: PlannedModVersion[] = [];
  const seen = new Map<string, PlannedModVersion>();
  const hashes = new Map(signatures.map((file) => [file.filename, file.sha1]));
  function installedDependency(id: string) {
    return installed.find((mod) =>
      mod.identities.some(
        (identity) =>
          identity.provider === source.id && identity.projectId === id
      )
    );
  }
  function installedReference(
    mod: InstalledMod,
    id: string,
    pin?: string | null
  ): ModProjectReference {
    if (
      pin &&
      !mod.identities.some(
        (identity) =>
          identity.provider === source.id &&
          identity.projectId === id &&
          identity.versionId === pin
      )
    )
      throw createError({
        statusCode: 409,
        statusMessage:
          "An installed dependency does not match the required version",
      });
    return {
      provider: source.id,
      projectId: id,
      ...(hashes.get(mod.filename) ? { sha1: hashes.get(mod.filename)! } : {}),
    };
  }
  async function visitInstalled(mod: InstalledMod, id: string) {
    if (!options.skipInstalled || seen.has(id)) return;
    const currentVersion = mod.identities.find(
      (identity) => identity.provider === source.id && identity.projectId === id
    )?.versionId;
    const current = await source.resolve(
      id,
      loader,
      gameVersion,
      currentVersion
    );
    if (!current)
      throw createError({
        statusCode: 409,
        statusMessage: `An installed dependency has no compatible build for ${loader} ${gameVersion}`,
      });
    await visit(current, mod);
  }
  async function visit(version: ModVersion, retainedMod?: InstalledMod) {
    const existing = seen.get(version.projectId);
    if (existing) {
      if (existing.versionId !== version.versionId)
        throw createError({
          statusCode: 409,
          statusMessage: "Required dependencies request conflicting versions",
        });
      return;
    }
    if (seen.size >= 50)
      throw createError({
        statusCode: 409,
        statusMessage: "Dependency graph exceeds the 50-project limit",
      });
    const entry: PlannedModVersion = {
      ...version,
      resolvedDependencies: [],
      ...(retainedMod ? { installedFilename: retainedMod.filename } : {}),
    };
    seen.set(version.projectId, entry);
    planned.push(entry);
    for (const dependency of version.dependencies) {
      let reference: ModProjectReference;
      const present = dependency.projectId
        ? installedDependency(dependency.projectId)
        : undefined;
      const alreadyPlanned = dependency.projectId
        ? seen.get(dependency.projectId)
        : undefined;
      if (present) {
        reference = installedReference(
          present,
          dependency.projectId!,
          dependency.versionId
        );
        await visitInstalled(present, dependency.projectId!);
      } else if (alreadyPlanned && !dependency.versionId)
        reference = {
          provider: source.id,
          projectId: alreadyPlanned.projectId,
          sha1: alreadyPlanned.sha1,
        };
      else {
        const resolved = await source.resolve(
          dependency.projectId,
          loader,
          gameVersion,
          dependency.versionId
        );
        if (!resolved)
          throw createError({
            statusCode: 409,
            statusMessage: `A required dependency has no compatible build for ${loader} ${gameVersion}`,
          });
        const installedMod = installedDependency(resolved.projectId);
        if (installedMod) {
          reference = installedReference(
            installedMod,
            resolved.projectId,
            dependency.versionId ? resolved.versionId : undefined
          );
          if (options.skipInstalled) await visit(resolved, installedMod);
        } else {
          reference = {
            provider: source.id,
            projectId: resolved.projectId,
            sha1: resolved.sha1,
          };
          await visit(resolved);
        }
      }
      if (
        !entry.resolvedDependencies.some(
          (item) =>
            item.provider === reference.provider &&
            item.projectId === reference.projectId
        )
      )
        entry.resolvedDependencies.push(reference);
      if (entry.resolvedDependencies.length > 100)
        throw createError({
          statusCode: 409,
          statusMessage: "A mod exceeds the 100 required dependencies limit",
        });
    }
  }
  await visit(root, retained);
  return planned;
}

export async function downloadModPlan(
  plan: (ModVersion & {
    resolvedDependencies?: ModProjectReference[];
    installedFilename?: string;
  })[],
  signatures: ModFileSignature[],
  provider: ModProvider,
  existingFilenames: string[] = [],
  options: { rootDependency?: boolean } = {}
) {
  const hashes = new Set(signatures.map((file) => file.sha1.toLowerCase()));
  const names = new Set([
    ...signatures.map((file) => file.filename),
    ...existingFilenames,
  ]);
  const added: {
    filename: string;
    version_number: string;
    dependency: boolean;
  }[] = [];
  const jars: JarFile[] = [];
  let total = 0;
  for (const [index, version] of plan.entries()) {
    if (version.provider !== provider)
      throw createError({
        statusCode: 502,
        statusMessage: "Unexpected dependency provider",
      });
    if (version.installedFilename) continue;
    if (hashes.has(version.sha1.toLowerCase())) {
      if (index === 0)
        throw createError({
          statusCode: 409,
          statusMessage:
            "This mod file is already installed, possibly from another source",
        });
      continue;
    }
    if (names.has(version.filename))
      throw createError({
        statusCode: 409,
        statusMessage: `"${version.filename}" already exists. Remove it before installing another build.`,
      });
    total += version.size;
    if (total > 300 * 1024 * 1024)
      throw createError({
        statusCode: 413,
        statusMessage: "Installation exceeds the 300 MB limit",
      });
    const jar = await downloadModFile(version);
    jars.push({
      ...jar,
      metadata: {
        project: { provider, projectId: version.projectId },
        dependencies: version.resolvedDependencies ?? [],
        dependency: index > 0 || options.rootDependency === true,
      },
    });
    added.push({
      filename: version.filename,
      version_number: version.version,
      dependency: index > 0 || options.rootDependency === true,
    });
    names.add(version.filename);
    hashes.add(version.sha1.toLowerCase());
  }
  return { jars, added };
}
