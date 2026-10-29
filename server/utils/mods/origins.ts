import { createHash } from "node:crypto";
import { extract } from "tar-stream";
import type { ModOrigin } from "../../../shared/types/mods";
import type { ModInstallMetadata, ModProjectReference } from "./types";

/** Travels with backups, restores and server copies; hidden from the file editor. */
export const MOD_ORIGINS_DIR = ".mcsm-mod-sources";
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECORDS = 10000;

export type ModOriginRecord = ModInstallMetadata & {
  version: 1;
  directory: string;
  filename: string;
  sha1: string;
  source: ModOrigin;
};

/** One record per filename avoids read/modify/write races between distinct jars. */
export function modOriginPath(directory: string, filename: string): string {
  const key = createHash("sha256")
    .update(`${directory}/${filename}`)
    .digest("hex");
  return `${MOD_ORIGINS_DIR}/${key}.json`;
}

export function modOriginFile(
  directory: string,
  jar: { name: string; data: Uint8Array; metadata?: ModInstallMetadata },
  source: Exclude<ModOrigin, "unknown">
) {
  const record: ModOriginRecord = {
    version: 1,
    directory,
    filename: jar.name,
    sha1: createHash("sha1").update(jar.data).digest("hex"),
    source,
    ...jar.metadata,
  };
  return {
    name: modOriginPath(directory, jar.name),
    data: Buffer.from(JSON.stringify(record)),
  };
}

function validProjectReference(value: unknown): value is ModProjectReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<ModProjectReference>;
  return (
    (reference.provider === "modrinth" ||
      reference.provider === "curseforge") &&
    typeof reference.projectId === "string" &&
    reference.projectId.length > 0 &&
    reference.projectId.length <= 128 &&
    (reference.sha1 === undefined ||
      (typeof reference.sha1 === "string" &&
        /^[a-f0-9]{40}$/.test(reference.sha1)))
  );
}

function validInstallMetadata(record: Partial<ModOriginRecord>): boolean {
  return (
    (record.project === undefined || validProjectReference(record.project)) &&
    (record.dependency === undefined ||
      typeof record.dependency === "boolean") &&
    (record.dependencies === undefined ||
      (Array.isArray(record.dependencies) &&
        record.dependencies.length <= 100 &&
        record.dependencies.every(validProjectReference)))
  );
}

export function recordedModSource(
  record: ModOriginRecord | undefined,
  sha1: string | undefined
): ModOrigin {
  return record && sha1 && record.sha1 === sha1 ? record.source : "unknown";
}

/** Read only small, versioned source records. Missing metadata means unknown. */
export async function readModOrigins(
  id: string,
  directory: string
): Promise<Record<string, ModOriginRecord>> {
  const { docker } = useDocker();
  let stream: NodeJS.ReadableStream;
  try {
    stream = await docker
      .getContainer(id)
      .getArchive({ path: `/data/${MOD_ORIGINS_DIR}` });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return {};
    throw error;
  }
  return new Promise((resolve, reject) => {
    const records: Record<string, ModOriginRecord> = Object.create(null);
    const tar = extract();
    let entries = 0;
    tar.on("entry", (header, entry, next) => {
      entry.on("error", reject);
      const path = header.name.replace(/^\.\//, "");
      if (++entries > MAX_RECORDS) {
        tar.destroy(new Error("Too many mod source records"));
        stream.unpipe(tar);
        stream.resume();
        return;
      }
      if (
        header.type !== "file" ||
        (header.size ?? 0) > MAX_RECORD_BYTES ||
        !path.endsWith(".json")
      ) {
        entry.on("end", next);
        entry.resume();
        return;
      }
      const chunks: Uint8Array[] = [];
      entry.on("data", (chunk) => chunks.push(chunk as Uint8Array));
      entry.on("end", () => {
        try {
          const record = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as Partial<ModOriginRecord> | null;
          if (
            record?.version === 1 &&
            record.directory === directory &&
            typeof record.filename === "string" &&
            /^[^/\\]+\.jar$/i.test(record.filename) &&
            typeof record.sha1 === "string" &&
            /^[a-f0-9]{40}$/.test(record.sha1) &&
            (record.source === "manual" ||
              record.source === "modrinth" ||
              record.source === "curseforge" ||
              record.source === "unknown") &&
            validInstallMetadata(record) &&
            path === modOriginPath(directory, record.filename)
          ) {
            records[record.filename] = record as ModOriginRecord;
          }
        } catch {
          /* Ignore malformed records rather than guessing a source. */
        }
        next();
      });
    });
    tar.on("finish", () => resolve(records));
    tar.on("error", reject);
    stream.on("error", reject);
    stream.pipe(tar);
  });
}
