import type { ModIdentity } from "../../../shared/types/mods";
import type { ModFileSignature, ModSource } from "./types";

const TTL = 5 * 60_000;
type Entry = { at: number; pending: Promise<ModIdentity | null> };
const cache = new Map<string, Map<string, Entry>>();

export function invalidateModIdentities(id: string) {
  for (const key of cache.keys())
    if (key.startsWith(`${id}:`)) cache.delete(key);
}

/** Cache misses too: unrecognized jars must not be retried after every install. */
export async function identifyModFiles(
  key: string,
  source: ModSource,
  files: ModFileSignature[],
  fresh = false
): Promise<Record<string, ModIdentity>> {
  let entries = cache.get(key);
  if (!entries) {
    entries = new Map();
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, entries);
  }
  const signatureKey = (file: ModFileSignature) =>
    `${file.sha1}:${file.fingerprint}`;
  const current = new Set(files.map(signatureKey));
  for (const hash of entries.keys())
    if (!current.has(hash)) entries.delete(hash);
  const unique = [
    ...new Map(files.map((file) => [signatureKey(file), file])).values(),
  ];
  const missing = unique.filter((file) => {
    const entry = entries.get(signatureKey(file));
    return !entry || (entry.at > 0 && (fresh || Date.now() - entry.at >= TTL));
  });
  if (missing.length) {
    const pending = source.identify(missing);
    for (const file of missing) {
      const hash = signatureKey(file);
      const entry: Entry = { at: 0, pending: Promise.resolve(null) };
      entry.pending = pending
        .then((identities) => {
          entry.at = Date.now();
          return identities[file.filename] ?? null;
        })
        .catch((error) => {
          if (entries.get(hash) === entry) entries.delete(hash);
          throw error;
        });
      entries.set(hash, entry);
    }
  }
  const results = await Promise.all(
    files.map(
      async (file) =>
        [file.filename, await entries.get(signatureKey(file))!.pending] as const
    )
  );
  return Object.fromEntries(
    results.filter(
      (entry): entry is readonly [string, ModIdentity] => entry[1] !== null
    )
  );
}
