import { createHash } from "node:crypto";
import type { JarFile, JarInfo } from "../minecraft/jars";
import type { ModFileSignature } from "./types";
import { curseforgeFingerprint } from "./fingerprint";
import { readModCache, writeModCache } from "./cache";

export type StoredSignature = { revision: string; signature: ModFileSignature };
type Snapshot = { version: 1; entries: Record<string, StoredSignature> };

export function jarRevision(file: JarInfo) {
  return `${file.size}:${file.revision ?? file.modifiedAt}`;
}

export function jarSignature(
  filename: string,
  data: Uint8Array
): ModFileSignature {
  return {
    filename,
    sha1: createHash("sha1").update(data).digest("hex"),
    fingerprint: curseforgeFingerprint(data),
  };
}

export async function readSignatureCache(key: string) {
  const snapshot = await readModCache<Snapshot>("signatures", key);
  const entries: Record<string, StoredSignature> = Object.create(null);
  if (snapshot?.version !== 1 || !snapshot.entries) return entries;
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    if (
      entry &&
      typeof entry.revision === "string" &&
      entry.signature?.filename === name &&
      /^[a-f0-9]{40}$/.test(entry.signature.sha1) &&
      Number.isInteger(entry.signature.fingerprint) &&
      entry.signature.fingerprint >= 0 &&
      entry.signature.fingerprint <= 0xffffffff
    )
      entries[name] = entry;
  }
  return entries;
}

export async function writeSignatureCache(
  key: string,
  entries: Record<string, StoredSignature>
) {
  await writeModCache("signatures", key, { version: 1, entries });
}

/** Bind bytes we just wrote to the filesystem revision captured after installation. */
export async function rememberInstalledJars(
  id: string,
  dir: string,
  jars: JarFile[],
  files: JarInfo[]
) {
  const key = `${id}:${dir}`;
  const entries = await readSignatureCache(key);
  const current = new Map(files.map((file) => [file.name, file]));
  for (const name of Object.keys(entries))
    if (!current.has(name)) delete entries[name];
  for (const jar of jars) {
    const file = current.get(jar.name);
    if (file?.revision && file.size === jar.data.length) {
      entries[jar.name] = {
        revision: jarRevision(file),
        signature: jarSignature(jar.name, jar.data),
      };
    }
  }
  await writeSignatureCache(key, entries);
}
