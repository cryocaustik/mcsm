import type { ModrinthVersion } from "../minecraft/modrinth-api";
import { checkUpdates } from "../minecraft/modrinth-api";
import { getModInventory, type ModServer } from "./inventory";

const TTL = 10 * 60_000;
type Entry = { at: number; pending: Promise<ModrinthVersion | null> };
const cache = new Map<string, Map<string, Entry>>();

/** Update checks share the inventory's hashes and only query uncached artifacts. */
export async function getModUpdates(
  id: string,
  server: ModServer,
  loader: string,
  gameVersion: string,
  fresh = false
) {
  const { inventory, signatures } = await getModInventory(id, server, {
    fresh,
  });
  const key = JSON.stringify([id, loader, gameVersion]);
  let entries = cache.get(key);
  if (!entries) {
    entries = new Map();
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, entries);
  }
  const mods = new Map(inventory.mods.map((mod) => [mod.filename, mod]));
  const hashes = [...new Set(signatures.map((file) => file.sha1))];
  const current = new Set(hashes);
  for (const hash of entries.keys())
    if (!current.has(hash)) entries.delete(hash);
  const missing = hashes.filter((hash) => {
    const entry = entries.get(hash);
    return !entry || (entry.at > 0 && (fresh || Date.now() - entry.at >= TTL));
  });
  if (missing.length) {
    const pending = checkUpdates(missing, loader, gameVersion);
    for (const hash of missing) {
      const entry: Entry = { at: 0, pending: Promise.resolve(null) };
      entry.pending = pending
        .then((latest) => {
          entry.at = Date.now();
          return latest[hash] ?? null;
        })
        .catch((error) => {
          if (entries.get(hash) === entry) entries.delete(hash);
          throw error;
        });
      entries.set(hash, entry);
    }
  }
  const latest = new Map(
    await Promise.all(
      hashes.map(
        async (hash) => [hash, await entries.get(hash)!.pending] as const
      )
    )
  );
  const projects: Record<string, { projectId: string; managed: boolean }> = {};
  const updates: {
    filename: string;
    projectId: string;
    currentSha1: string;
    latestVersion: string;
    latestFilename: string;
    managed: boolean;
  }[] = [];
  for (const file of signatures) {
    const mod = mods.get(file.filename);
    const identity = mod?.identities.find(
      (identity) => identity.provider === "modrinth"
    );
    if (!identity) continue;
    const managed = mod!.managed;
    projects[file.filename] = { projectId: identity.projectId, managed };
    const version = latest.get(file.sha1);
    const newest =
      version?.files.find((file) => file.primary) ?? version?.files[0];
    if (!version || !newest || newest.hashes.sha1 === file.sha1) continue;
    updates.push({
      filename: file.filename,
      projectId: identity.projectId,
      currentSha1: file.sha1,
      latestVersion: version.version_number,
      latestFilename: newest.filename,
      managed,
    });
  }
  return { loader, gameVersion, projects, updates };
}
