import type { ModIdentity } from "../../../shared/types/mods";
import type { ModFileSignature, ModSource } from "./types";
import { readModCache, writeModCache, validModIdentity } from "./cache";

const TTL = 5 * 60_000;
type Entry = {
  at: number;
  value?: ModIdentity | null;
  pending: Promise<ModIdentity | null>;
  refreshing: boolean;
  retryAt?: number;
};
type StoredEntry = { at: number; value: ModIdentity | null };
type State = { entries: Map<string, Entry>; loaded: Promise<void> };
const cache = new Map<string, State>();
const signatureKey = (file: ModFileSignature) =>
  `${file.sha1}:${file.fingerprint}`;

export function invalidateModIdentities(id: string) {
  for (const key of cache.keys())
    if (key.startsWith(`${id}:`)) cache.delete(key);
}

export function modIdentitiesRefreshing(
  key: string,
  files: ModFileSignature[]
) {
  const entries = cache.get(key)?.entries;
  return files.some((file) => entries?.get(signatureKey(file))?.refreshing);
}

async function stateFor(key: string) {
  let state = cache.get(key);
  if (!state) {
    const entries = new Map<string, Entry>();
    state = {
      entries,
      loaded: (async () => {
        const saved = await readModCache<{
          version: number;
          entries: Record<string, StoredEntry>;
        }>("identities", key);
        if (saved?.version !== 1 || !saved.entries) return;
        for (const [hash, entry] of Object.entries(saved.entries)) {
          if (
            !/^[a-f0-9]{40}:\d+$/.test(hash) ||
            !entry ||
            !Number.isFinite(entry.at) ||
            (entry.value !== null && !validModIdentity(entry.value))
          )
            continue;
          entries.set(hash, {
            ...entry,
            pending: Promise.resolve(entry.value),
            refreshing: false,
          });
        }
      })(),
    };
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, state);
  }
  await state.loaded;
  return state;
}

async function persist(key: string, entries: Map<string, Entry>) {
  const saved: Record<string, StoredEntry> = Object.create(null);
  for (const [hash, entry] of entries) {
    if (entry.value !== undefined)
      saved[hash] = { at: entry.at, value: entry.value };
  }
  await writeModCache("identities", key, { version: 1, entries: saved });
}

/** Hydrate before launching providers so any known identity can unblock a row. */
export async function cachedModIdentities(
  key: string,
  source: ModSource,
  files: ModFileSignature[],
  seeds: Record<string, ModIdentity> = {}
): Promise<Record<string, ModIdentity>> {
  const { entries } = await stateFor(key);
  let seeded = false;
  const result: Record<string, ModIdentity> = Object.create(null);
  for (const file of files) {
    const hash = signatureKey(file);
    const identity = seeds[file.filename];
    if (
      !entries.get(hash)?.value &&
      validModIdentity(identity) &&
      identity.provider === source.id
    ) {
      entries.set(hash, {
        at: Date.now(),
        value: identity,
        pending: Promise.resolve(identity),
        refreshing: false,
      });
      seeded = true;
    }
    const value = entries.get(hash)?.value;
    if (value?.provider === source.id) result[file.filename] = value;
  }
  if (seeded) await persist(key, entries);
  return result;
}

/** Reuse verified identities immediately; stale metadata refreshes in the background. */
export async function identifyModFiles(
  key: string,
  source: ModSource,
  files: ModFileSignature[],
  fresh = false,
  background: Set<string> = new Set()
): Promise<Record<string, ModIdentity>> {
  const { entries } = await stateFor(key);
  const current = new Set(files.map(signatureKey));
  for (const [hash, entry] of entries)
    if (!current.has(hash) && !entry.refreshing) entries.delete(hash);
  const unique = [
    ...new Map(files.map((file) => [signatureKey(file), file])).values(),
  ];
  const missing = unique.filter((file) => {
    const entry = entries.get(signatureKey(file));
    return (
      !entry ||
      (!entry.refreshing &&
        (fresh ||
          (Date.now() >= (entry.retryAt ?? 0) && Date.now() - entry.at >= TTL)))
    );
  });
  if (missing.length) {
    const batch = source.identify(missing).then(async (identities) => {
      for (const file of missing) {
        const entry = entries.get(signatureKey(file));
        if (!entry) continue;
        const identity = identities[file.filename];
        // A provider's failed/malformed response must not erase a verified match.
        entry.value =
          validModIdentity(identity) && identity.provider === source.id
            ? identity
            : (entry.value ?? null);
        entry.at = Date.now();
        entry.refreshing = false;
        entry.retryAt = undefined;
      }
      await persist(key, entries);
    });
    for (const file of missing) {
      const hash = signatureKey(file);
      const previous = entries.get(hash);
      const next: Entry = {
        at: previous?.at ?? 0,
        value: previous?.value,
        pending: Promise.resolve(null),
        refreshing: true,
      };
      next.pending = batch
        .then(() => next.value ?? null)
        .catch((error) => {
          if (entries.get(hash) === next) {
            if (previous?.value !== undefined) {
              previous.retryAt = Date.now() + 60_000;
              entries.set(hash, previous);
            } else entries.delete(hash);
          }
          throw error;
        });
      // Background work must never leave rejected promises unobserved.
      void next.pending.catch(() => {});
      entries.set(hash, next);
    }
  }
  const results = await Promise.all(
    files.map(async (file) => {
      const entry = entries.get(signatureKey(file))!;
      const value =
        !fresh && entry.value !== undefined
          ? entry.value
          : !fresh && background.has(file.filename)
            ? null
            : await entry.pending;
      return [file.filename, value] as const;
    })
  );
  return Object.fromEntries(
    results.filter(
      (entry): entry is readonly [string, ModIdentity] => entry[1] !== null
    )
  );
}
