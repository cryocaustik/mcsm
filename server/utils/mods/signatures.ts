import { createHash } from "node:crypto";
import { listJars, readJar, type JarInfo } from "../minecraft/jars";
import { curseforgeFingerprint } from "./fingerprint";
import type { ModFileSignature } from "./types";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_AGE = 5 * 60_000;
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
        const revision = `${file.size}:${file.revision ?? file.modifiedAt}`;
        let entry = entries.get(file.name);
        if (
          !entry ||
          entry.revision !== revision ||
          (entry.at &&
            (options.fresh ||
              !file.revision ||
              Date.now() - entry.at > MAX_AGE))
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
                const signature = {
                  filename: file.name,
                  sha1: createHash("sha1").update(data).digest("hex"),
                  fingerprint: curseforgeFingerprint(data),
                };
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
  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}
