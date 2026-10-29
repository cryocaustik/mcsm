import type { ModIdentity, ModProject } from "../../../shared/types/mods";
import type { ModSource, ModVersion } from "./types";
import { modError, modNetworkCode } from "./errors";

type CurseForgeProject = {
  id: number;
  slug: string;
  name: string;
  summary: string;
  logo?: { thumbnailUrl: string } | null;
  downloadCount: number;
};
export type CurseForgeFile = {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  downloadUrl: string | null;
  fileLength: number;
  gameVersions: string[];
  hashes: { algo: number; value: string }[];
  dependencies: { modId: number; relationType: number }[];
};

const LOADERS: Record<string, { id: number; name: string }> = {
  forge: { id: 1, name: "Forge" },
  fabric: { id: 4, name: "Fabric" },
  neoforge: { id: 6, name: "NeoForge" },
};

function projectInfo(project: CurseForgeProject, plugin = false): ModProject {
  return {
    provider: "curseforge",
    projectId: String(project.id),
    slug: project.slug,
    name: project.name,
    description: project.summary,
    iconUrl: project.logo?.thumbnailUrl ?? null,
    websiteUrl: `https://www.curseforge.com/minecraft/${plugin ? "bukkit-plugins" : "mc-mods"}/${encodeURIComponent(project.slug)}`,
    downloads: project.downloadCount,
  };
}

function versionInfo(file: CurseForgeFile): ModVersion {
  return {
    provider: "curseforge",
    projectId: String(file.modId),
    versionId: String(file.id),
    version: file.displayName,
    filename: file.fileName,
    downloadUrl: file.downloadUrl,
    size: file.fileLength,
    sha1:
      file.hashes.find((hash) => hash.algo === 1)?.value.toLowerCase() ?? "",
    dependencies: file.dependencies
      .filter((dep) => dep.relationType === 3)
      .map((dep) => ({ projectId: String(dep.modId) })),
  };
}

/** The key is sent only to api.curseforge.com and is never included in errors. */
export function createCurseforgeSource(
  apiKey: string,
  plugin = false
): ModSource {
  async function request<T>(
    path: string,
    options: { query?: Record<string, string | number>; body?: unknown } = {}
  ): Promise<T> {
    try {
      return (await $fetch<T>(`https://api.curseforge.com/v1${path}`, {
        method: options.body ? "POST" : "GET",
        headers: { "x-api-key": apiKey },
        query: options.query,
        body: options.body as Record<string, unknown> | undefined,
        timeout: 10_000,
        retry: 0,
      })) as T;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      const networkCode = modNetworkCode(error);
      const timedOut =
        networkCode === "ETIMEDOUT" ||
        networkCode === "UND_ERR_CONNECT_TIMEOUT" ||
        (error as { cause?: { name?: string } }).cause?.name === "TimeoutError";
      const context = {
        provider: "curseforge" as const,
        stage:
          path === "/mods/search"
            ? ("search" as const)
            : path === "/fingerprints" || path === "/mods"
              ? ("identify" as const)
              : ("resolve" as const),
        projectId: /^\/mods\/(\d+)/.exec(path)?.[1],
        host: "api.curseforge.com",
        upstreamStatus: status,
        networkCode,
      };
      if (status === 401 || status === 403)
        throw modError(502, {
          ...context,
          code: "PROVIDER_KEY_REJECTED",
          message: "CurseForge rejected the API key.",
          hint: "Ask an administrator to check the key in Admin > Secrets.",
          retryable: false,
        });
      if (status === 404)
        throw modError(404, {
          ...context,
          code: "PROVIDER_NOT_FOUND",
          message: "Project or file not found on CurseForge.",
          hint: "Refresh the search or check the source page for this project.",
          retryable: false,
        });
      if (status === 429)
        throw modError(503, {
          ...context,
          code: "PROVIDER_RATE_LIMIT",
          message: "CurseForge rate limit reached.",
          hint: "Wait a minute before trying again.",
          retryable: true,
        });
      if (timedOut)
        throw modError(504, {
          ...context,
          code: "PROVIDER_TIMEOUT",
          message: "The CurseForge API request timed out.",
          hint: "Retry shortly and check outbound HTTPS connectivity if this continues.",
          retryable: true,
        });
      throw modError(502, {
        ...context,
        code: status ? "PROVIDER_HTTP_ERROR" : "PROVIDER_NETWORK_ERROR",
        message: status
          ? `CurseForge returned HTTP ${status}.`
          : "The server could not connect to CurseForge.",
        hint:
          networkCode === "ENOTFOUND" || networkCode === "EAI_AGAIN"
            ? "Check DNS resolution and outbound network access on the MCSM host."
            : "Try again shortly. If this continues, check the provider's availability and the MCSM host's outbound connection.",
        retryable: !status || status >= 500,
      });
    }
  }
  return {
    id: "curseforge",
    async search(options) {
      const loader = LOADERS[options.loader];
      if (options.loader !== "paper" && !loader)
        throw createError({
          statusCode: 400,
          statusMessage: "This loader is not supported by CurseForge",
        });
      const { data, pagination } = await request<{
        data: CurseForgeProject[];
        pagination: { totalCount: number };
      }>("/mods/search", {
        query: {
          gameId: 432,
          classId: options.loader === "paper" ? 5 : 6,
          searchFilter: options.query,
          gameVersion: options.gameVersion,
          ...(loader ? { modLoaderType: loader.id } : {}),
          index: options.offset,
          pageSize: 20,
          sortField: { relevance: 1, downloads: 6, updated: 3, newest: 11 }[
            options.sort
          ],
          sortOrder: "desc",
        },
      });
      return {
        hits: data.map((project) =>
          projectInfo(project, options.loader === "paper")
        ),
        total: pagination.totalCount,
      };
    },
    async resolve(projectId, loader, gameVersion, versionId) {
      if (!projectId || !/^\d+$/.test(projectId)) return null;
      const loaderInfo = LOADERS[loader];
      if (loader !== "paper" && !loaderInfo) return null;
      if (versionId) {
        const { data } = await request<{ data: CurseForgeFile }>(
          `/mods/${projectId}/files/${encodeURIComponent(versionId)}`
        );
        return data.gameVersions.includes(gameVersion) &&
          (!loaderInfo || data.gameVersions.includes(loaderInfo.name))
          ? versionInfo(data)
          : null;
      }
      const { data } = await request<{ data: CurseForgeFile[] }>(
        `/mods/${projectId}/files`,
        {
          query: {
            gameVersion,
            ...(loaderInfo ? { modLoaderType: loaderInfo.id } : {}),
            pageSize: 50,
          },
        }
      );
      const file = data.find(
        (file) =>
          file.gameVersions.includes(gameVersion) &&
          (!loaderInfo || file.gameVersions.includes(loaderInfo.name))
      );
      return file ? versionInfo(file) : null;
    },
    async identify(files) {
      const identities: Record<string, ModIdentity> = {};
      for (let offset = 0; offset < files.length; offset += 100) {
        const batch = files.slice(offset, offset + 100);
        const { data } = await request<{
          data: { exactMatches: { id: number; file: CurseForgeFile }[] };
        }>("/fingerprints", {
          body: { fingerprints: batch.map((file) => file.fingerprint) },
        });
        const ids = [...new Set(data.exactMatches.map((match) => match.id))];
        if (!ids.length) continue;
        const { data: projects } = await request<{ data: CurseForgeProject[] }>(
          "/mods",
          { body: { modIds: ids } }
        );
        const byId = new Map(projects.map((project) => [project.id, project]));
        for (const file of batch) {
          // A 32-bit fingerprint can collide; SHA-1 must also agree.
          const match = data.exactMatches.find((match) =>
            match.file.hashes.some(
              (hash) =>
                hash.algo === 1 && hash.value.toLowerCase() === file.sha1
            )
          );
          const project = match && byId.get(match.id);
          if (match && project)
            identities[file.filename] = {
              ...projectInfo(project, plugin),
              version: match.file.displayName,
              versionId: String(match.file.id),
            };
        }
      }
      return identities;
    },
  };
}
