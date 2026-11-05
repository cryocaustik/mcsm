import { listJars, readJar, type JarInfo } from "../minecraft/jars";
import type { ModFileSignature } from "./types";

import {
  jarRevision,
  jarSignature,
  readSignatureCache,
  writeSignatureCache,
  type StoredSignature,
} from "./signature-cache";

const MAX_BYTES = 100 * 1024 * 1024;
type SignatureEntry = {
  revision: string;
  at: number;
  pending: Promise<ModFileSignature>;
};
const cache = new Map<string, Map<string, SignatureEntry>>();

export function invalidateModSignatures(id: string) {
  for (const key of cache.keys())
    if (key.startsWith(`${id}:`)) cache.delete(key);
}

/** Share hashes across inventory/update requests; read only new or changed jars. */
export async function scanModSignatures(
  id: string,
  dir: string,
  options: { files?: JarInfo[]; fresh?: boolean } = {}
): Promise<ModFileSignature[]> {
  const files = options.files ?? (await listJars(id, dir));
  const key = `${id}:${dir}`;
  let entries = cache.get(key);
  if (!entries) {
    entries = new Map();
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, entries);
  }
  const persisted = await readSignatureCache(key);
  const current = new Set(files.map((file) => file.name));
  for (const name of entries.keys())
    if (!current.has(name)) entries.delete(name);
  const results: ModFileSignature[] = [];
  // Four archive requests at a time bounds memory and avoids serial round trips.
  const queue = files.filter((file) => file.size <= MAX_BYTES);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        const file = queue[cursor++]!;
        const revision = jarRevision(file);
        let entry = entries.get(file.name);
        if (
          !options.fresh &&
          file.revision &&
          persisted[file.name]?.revision === revision &&
          (!entry || entry.revision !== revision)
        ) {
          entry = {
            revision,
            at: Date.now(),
            pending: Promise.resolve(persisted[file.name]!.signature),
          };
          entries.set(file.name, entry);
        }
        if (
          !entry ||
          entry.revision !== revision ||
          (entry.at && (options.fresh || !file.revision))
        ) {
          const next: SignatureEntry = {
            revision,
            at: 0,
            pending: readJar(id, dir, file.name, { maxBytes: MAX_BYTES })
              .then((data) => {
                if (data.length !== file.size)
                  throw new Error(
                    "Installed jar changed during identification; refresh to retry"
                  );
                const signature = jarSignature(file.name, data);
                next.at = Date.now();
                return signature;
              })
              .catch((error) => {
                if (entries.get(file.name) === next) entries.delete(file.name);
                throw error;
              }),
          };
          entries.set(file.name, next);
          entry = next;
        }
        results.push(await entry.pending);
      }
    })
  );
  const stored: Record<string, StoredSignature> = Object.create(null);
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const signature of results) {
    const file = byName.get(signature.filename)!;
    if (file.revision)
      stored[file.name] = { revision: jarRevision(file), signature };
  }
  if (
    Object.keys(stored).length !== Object.keys(persisted).length ||
    Object.entries(stored).some(([name, entry]) => {
      const saved = persisted[name];
      return (
        !saved ||
        saved.revision !== entry.revision ||
        saved.signature.sha1 !== entry.signature.sha1 ||
        saved.signature.fingerprint !== entry.signature.fingerprint
      );
    })
  )
    await writeSignatureCache(key, stored);
  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}
