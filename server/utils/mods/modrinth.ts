import type { ModIdentity, ModProject } from "../../../shared/types/mods";
import {
  findCompatibleVersion,
  getModrinthProjects,
  getModrinthVersion,
  identifyHashes,
  searchProjects,
  type ModrinthProject,
  type ModrinthVersion,
} from "../minecraft/modrinth-api";
import type {
  ModInstallMetadata,
  ModProjectReference,
  ModSource,
  ModVersion,
} from "./types";
import type { ModOriginRecord } from "./origins";

/** Refresh forward links on updates while keeping the automatic-install history. */
export async function modrinthUpdateMetadata(
  version: ModrinthVersion,
  previous: ModOriginRecord | undefined,
  previousSha1: string
): Promise<ModInstallMetadata> {
  const validPrevious = previous?.sha1 === previousSha1 ? previous : undefined;
  const dependencies: ModProjectReference[] = [];
  for (const dependency of version.dependencies) {
    if (dependency.dependency_type !== "required") continue;
    let projectId = dependency.project_id;
    let sha1: string | undefined;
    if (!projectId && dependency.version_id) {
      const pinned = await getModrinthVersion(dependency.version_id);
      projectId = pinned.project_id;
      sha1 = (pinned.files.find((file) => file.primary) ?? pinned.files[0])
        ?.hashes.sha1;
    }
    if (!projectId)
      throw createError({
        statusCode: 502,
        statusMessage:
          "Could not identify a required dependency of the updated mod",
      });
    sha1 ??= validPrevious?.dependencies?.find(
      (ref) => ref.provider === "modrinth" && ref.projectId === projectId
    )?.sha1;
    if (!dependencies.some((ref) => ref.projectId === projectId))
      dependencies.push({
        provider: "modrinth",
        projectId,
        ...(sha1 ? { sha1 } : {}),
      });
    if (dependencies.length > 100)
      throw createError({
        statusCode: 409,
        statusMessage: "A mod exceeds the 100 required dependencies limit",
      });
  }
  return {
    project: { provider: "modrinth", projectId: version.project_id },
    dependencies,
    dependency: validPrevious?.dependency === true,
  };
}

function projectInfo(project: ModrinthProject): ModProject {
  return {
    provider: "modrinth",
    projectId: project.id,
    slug: project.slug,
    name: project.title,
    description: "",
    iconUrl: project.icon_url,
    websiteUrl: `https://modrinth.com/${project.project_type === "plugin" ? "plugin" : "mod"}/${encodeURIComponent(project.slug)}`,
    downloads: 0,
  };
}

function versionInfo(version: ModrinthVersion): ModVersion | null {
  const file = version.files.find((file) => file.primary) ?? version.files[0];
  if (!file) return null;
  return {
    provider: "modrinth",
    projectId: version.project_id,
    versionId: version.id,
    version: version.version_number,
    filename: file.filename,
    downloadUrl: file.url,
    size: file.size,
    sha1: file.hashes.sha1,
    dependencies: version.dependencies
      .filter((dep) => dep.dependency_type === "required")
      .map((dep) => ({ projectId: dep.project_id, versionId: dep.version_id })),
  };
}

export const modrinthSource: ModSource = {
  id: "modrinth",
  async search(options) {
    const response = await searchProjects(options);
    return {
      hits: response.hits.map((hit) => ({
        ...projectInfo({
          id: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          icon_url: hit.icon_url,
          project_type: hit.project_type,
        }),
        description: hit.description,
        downloads: hit.downloads,
      })),
      total: response.total,
    };
  },
  async resolve(projectId, loader, gameVersion, versionId) {
    const version = versionId
      ? await getModrinthVersion(versionId)
      : projectId
        ? await findCompatibleVersion(projectId, loader, gameVersion)
        : null;
    if (!version) return null;
    if (
      versionId &&
      (!version.loaders?.includes(loader) ||
        !version.game_versions?.includes(gameVersion))
    )
      return null;
    if (projectId && versionId && version.project_id !== projectId) return null;
    return versionInfo(version);
  },
  async identify(files) {
    if (!files.length) return {};
    const versions = await identifyHashes(files.map((file) => file.sha1));
    const projects = await getModrinthProjects([
      ...new Set(Object.values(versions).map((version) => version.project_id)),
    ]);
    const byId = new Map(projects.map((project) => [project.id, project]));
    const identities: Record<string, ModIdentity> = {};
    for (const file of files) {
      const version = versions[file.sha1];
      const project = version && byId.get(version.project_id);
      if (version && project)
        identities[file.filename] = {
          ...projectInfo(project),
          version: version.version_number,
          versionId: version.id,
        };
    }
    return identities;
  },
};
