import { createHash } from "node:crypto";
import type { ModIdentity } from "../../../shared/types/mods";

const writes = new Map<string, Promise<void>>();

/** Optional, persistent acceleration data; a cache failure must never fail an install. */
export async function readModCache<T>(
  kind: string,
  key: string
): Promise<T | null> {
  const storedKey = cacheKey(kind, key);
  try {
    await writes.get(storedKey);
    return await useStorage("modCache").getItem<T>(storedKey);
  } catch {
    return null;
  }
}

export async function writeModCache(kind: string, key: string, value: object) {
  const storedKey = cacheKey(kind, key);
  // Inventory and update checks can persist the same snapshot concurrently.
  const pending = (writes.get(storedKey) ?? Promise.resolve()).then(
    async () => {
      try {
        await useStorage("modCache").setItem(storedKey, value);
      } catch {
        // Discovery and identification remain available without a writable cache.
      }
    }
  );
  writes.set(storedKey, pending);
  await pending;
  if (writes.get(storedKey) === pending) writes.delete(storedKey);
}

function cacheKey(kind: string, key: string) {
  return `${kind}:${createHash("sha256").update(key).digest("hex")}`;
}

export function validModIdentity(value: unknown): value is ModIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as ModIdentity;
  const webUrl = (url: unknown) =>
    typeof url === "string" && url.length <= 4096 && /^https?:\/\//.test(url);
  return (
    (identity.provider === "modrinth" || identity.provider === "curseforge") &&
    [
      identity.projectId,
      identity.slug,
      identity.name,
      identity.version,
      identity.versionId,
    ].every(
      (field) =>
        typeof field === "string" && field.length > 0 && field.length <= 4096
    ) &&
    typeof identity.description === "string" &&
    typeof identity.downloads === "number" &&
    Number.isFinite(identity.downloads) &&
    (identity.iconUrl === null || webUrl(identity.iconUrl)) &&
    webUrl(identity.websiteUrl)
  );
}
