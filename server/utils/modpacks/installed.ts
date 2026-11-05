import { extract } from "tar-stream";
import { posix } from "node:path";
import type { ServerConfig } from "../../schema/server.schema";
import type {
  InstalledPack,
  ModpackPlatform,
} from "../../../shared/types/modpacks";

export type PackServer = {
  id: string;
  volume?: string | null;
  config: ServerConfig | null;
  running: boolean;
};
import { packPlatform, packVersion } from "../../../shared/utils/modpacks";
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
export function managedPackPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  )
    return null;
  const path = value.replace(/^\.\//, "");
  if (path.split("/").includes("..") || posix.normalize(path) !== path)
    return null;
  return path;
}
function resultsEnv(contents: string | null) {
  const result: Record<string, string> = Object.create(null);
  for (const line of (contents ?? "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) result[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}
/** Read these as data, never source/evaluate the installer's environment file. */
export function parseInstalledPack(
  platform: ModpackPlatform,
  raw: string,
  resultText: string | null
): InstalledPack {
  const data = JSON.parse(raw);
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray(data.files) ||
    data.files.length > 10000
  )
    throw new Error("Unsupported modpack manifest");
  const env = resultsEnv(resultText);
  const files: string[] = [];
  const hashes: Record<string, string> = Object.create(null);
  for (const file of data.files) {
    if (
      platform === "ftb" &&
      (!file ||
        typeof file.path !== "string" ||
        typeof file.name !== "string" ||
        file.name.includes("/") ||
        file.name.includes("\\"))
    )
      throw new Error("Invalid FTB file entry");
    const path =
      platform === "ftb" && file && typeof file === "object"
        ? managedPackPath(`${file.path?.replace(/\/$/, "")}/${file.name}`)
        : managedPackPath(file);
    if (!path) throw new Error("Invalid path in modpack manifest");
    files.push(path);
    if (
      platform === "ftb" &&
      file.hash_type === "sha1" &&
      /^[a-f0-9]{40}$/i.test(file.hash)
    )
      hashes[path] = file.hash.toLowerCase();
  }
  let versionId: string | null,
    projectId: string | null,
    slug: string | null,
    name: string | null,
    versionName: string | null,
    minecraft: string | null,
    loader: string | null,
    loaderVersion: string | null,
    receipt: boolean;
  if (platform === "curseforge") {
    versionId = text(data.fileId);
    projectId = text(data.modId);
    slug = text(data.slug);
    name = text(data.modpackName);
    versionName = text(data.modpackVersion);
    minecraft = text(data.minecraftVersion);
    const loaderId = text(data.modLoaderId);
    loader = loaderId?.split("-")[0]?.toLowerCase() ?? null;
    loaderVersion = loaderId?.slice(loader!.length + 1) ?? null;
    receipt = Boolean(
      env.MODPACK_NAME &&
      env.MODPACK_NAME === name &&
      env.MODPACK_VERSION === versionName
    );
  } else if (platform === "modrinth") {
    versionId = text(data.versionId);
    projectId = null;
    slug = text(data.projectSlug);
    name = env.MODPACK_NAME ?? null;
    versionName = env.MODPACK_VERSION ?? null;
    minecraft = text(data.dependencies?.minecraft);
    const selected = [
      "neoforge",
      "forge",
      "fabric-loader",
      "quilt-loader",
    ].find((key) => data.dependencies?.[key]);
    loader = selected?.replace("-loader", "") ?? null;
    loaderVersion = selected ? text(data.dependencies[selected]) : null;
    receipt = Boolean(name && versionName && env.VERSION === minecraft);
  } else {
    versionId = text(data.versionId);
    projectId = text(data.id);
    slug = null;
    name = text(data.name);
    versionName = text(data.versionName);
    minecraft = text(data.modPackTargets?.mcVersion);
    loader = text(data.modPackTargets?.modLoader?.name)?.toLowerCase() ?? null;
    loaderVersion = text(data.modPackTargets?.modLoader?.version);
    receipt = resultText?.trim() === `${projectId}=${versionId}`;
  }
  if (!versionId || (!projectId && !slug))
    throw new Error("Modpack manifest has no project/version identity");
  return {
    platform,
    projectId,
    slug,
    name,
    versionId,
    versionName,
    minecraft,
    loader,
    loaderVersion,
    files: [...new Set(files)],
    hashes,
    receipt,
  };
}

async function readInstallerFile(
  id: string,
  path: string
): Promise<string | null> {
  let stream: NodeJS.ReadableStream;
  try {
    stream = await useDocker()
      .docker.getContainer(id)
      .getArchive({ path: `/data/${path}` });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const tar = extract();
    let value: string | null = null;
    let bytes = 0;
    tar.on("entry", (header, entry, next) => {
      if (header.type !== "file") {
        entry.resume();
        entry.on("end", next);
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk) => {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        if (bytes > 4 * 1024 * 1024) {
          tar.destroy(new Error("Modpack manifest exceeds 4 MiB"));
          stream.unpipe(tar);
          stream.resume();
          return;
        }
        chunks.push(buffer);
      });
      entry.on("error", reject);
      entry.on("end", () => {
        value = Buffer.concat(chunks).toString("utf8");
        next();
      });
    });
    tar.on("finish", () => resolve(value));
    tar.on("error", reject);
    stream.on("error", reject);
    stream.pipe(tar);
  });
}
const reads = new Map<
  string,
  { at: number; pending: Promise<InstalledPack | null> }
>();
export function invalidateInstalledPack(id: string) {
  for (const key of reads.keys())
    if (key.startsWith(`${id}:`)) reads.delete(key);
}
export async function readInstalledPack(
  id: string,
  config: ServerConfig | null,
  fresh = false
): Promise<InstalledPack | null> {
  const platform = packPlatform(config);
  if (!platform) return null;
  const key = `${id}:${platform}`;
  const cached = reads.get(key);
  if (cached && (!cached.at || (!fresh && Date.now() - cached.at < 2000)))
    return cached.pending;
  const paths = {
    curseforge: [".curseforge-manifest.json", ".install-curseforge.env"],
    modrinth: [".modrinth-modpack-manifest.json", ".install-modrinth.env"],
    ftb: [".manifest.json", ".ftb-installed"],
  }[platform];
  const entry = {
    at: 0,
    pending: Promise.resolve(null as InstalledPack | null),
  };
  entry.pending = Promise.all(paths.map((path) => readInstallerFile(id, path)))
    .then(([manifest, result]) => {
      entry.at = Date.now();
      return manifest
        ? parseInstalledPack(platform, manifest, result ?? null)
        : null;
    })
    .catch((error) => {
      if (reads.get(key) === entry) reads.delete(key);
      throw error;
    });
  reads.set(key, entry);
  return entry.pending;
}
export async function assertPackOwnedFilesMutable(
  id: string,
  server: PackServer,
  filenames: string[]
) {
  if (!packPlatform(server.config)) return;
  const installed = await readInstalledPack(id, server.config, true);
  if (
    !installed?.receipt ||
    (packVersion(server.config!) &&
      installed.versionId !== packVersion(server.config!))
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        "Wait for the modpack to finish installing before changing mods.",
    });
  const owned = new Set(installed.files);
  const conflicts = filenames.filter((name) => owned.has(`mods/${name}`));
  if (conflicts.length)
    throw createError({
      statusCode: 409,
      statusMessage: `Managed by the modpack: ${conflicts.join(", ")}. Change the modpack version instead.`,
    });
}
