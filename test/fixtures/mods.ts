import type {
  InstalledMod,
  ModIdentity,
  ModProvider,
} from "../../shared/types/mods";
import type { ModVersion } from "../../server/utils/mods/types";

export function identity(
  projectId: string,
  provider: ModProvider = "modrinth"
): ModIdentity {
  return {
    provider,
    projectId,
    slug: projectId,
    name: `Mod ${projectId}`,
    description: "",
    iconUrl: null,
    websiteUrl: `https://example.com/${projectId}`,
    downloads: 0,
    version: "1.0",
    versionId: `${projectId}-v1`,
  };
}

export function installed(
  projectId: string,
  provider: ModProvider = "modrinth"
): InstalledMod {
  return {
    filename: `${projectId}.jar`,
    size: 3,
    modifiedAt: null,
    source: provider,
    dependency: false,
    requiredBy: [],
    identities: [identity(projectId, provider)],
    managed: false,
  };
}

export function version(
  projectId: string,
  overrides: Partial<ModVersion> = {}
): ModVersion {
  return {
    provider: "modrinth",
    projectId,
    versionId: `${projectId}-v1`,
    version: "1.0",
    filename: `${projectId}.jar`,
    downloadUrl: `https://cdn.modrinth.com/${projectId}.jar`,
    sha1: "a".repeat(40),
    size: 3,
    dependencies: [],
    ...overrides,
  };
}

export function apiError(options: {
  statusCode: number;
  statusMessage: string;
}) {
  return Object.assign(new Error(options.statusMessage), options);
}
