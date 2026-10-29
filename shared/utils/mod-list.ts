import * as v from "valibot";
import type { InstalledMod } from "../types/mods";
import type { ModList, ModListEntry, ModListField } from "../types/mod-list";
import { installedModLinkIdentity } from "./mods";

export const MAX_MOD_LIST_BYTES = 2 * 1024 * 1024;
export const MAX_MOD_LIST_ENTRIES = 1000;
const text = (max = 512) => v.pipe(v.string(), v.maxLength(max));
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const filename = v.pipe(text(255), v.regex(/^[^/\\]+\.jar$/i));
const details = {
  name: v.optional(text()),
  filename: v.optional(filename),
  version: v.optional(text()),
  source: v.optional(
    v.picklist(["modrinth", "curseforge", "manual", "unknown"])
  ),
  websiteUrl: v.optional(v.pipe(text(2048), v.url(), v.startsWith("https://"))),
  size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  modifiedAt: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
  dependency: v.optional(v.boolean(), false),
};
const schema = v.object({
  format: v.literal("mcsm-mod-list"),
  version: v.literal(1),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  environment: v.optional(
    v.object({
      name: v.optional(text()),
      loader: v.optional(text(64)),
      minecraftVersion: v.optional(text(64)),
    })
  ),
  mods: v.pipe(
    v.array(
      v.variant("provider", [
        v.object({
          ...details,
          provider: v.literal("modrinth"),
          projectId: id,
          versionId: v.optional(id),
        }),
        v.object({
          ...details,
          provider: v.literal("curseforge"),
          projectId: v.pipe(id, v.regex(/^\d+$/)),
          versionId: v.optional(v.pipe(id, v.regex(/^\d+$/))),
        }),
        v.object({ ...details, provider: v.literal("manual"), filename }),
      ])
    ),
    v.maxLength(MAX_MOD_LIST_ENTRIES)
  ),
});

export function parseModList(json: string): ModList {
  if (new TextEncoder().encode(json).length > MAX_MOD_LIST_BYTES)
    throw new Error("Mod lists must be smaller than 2 MB.");
  let value: unknown;
  try {
    value = JSON.parse(json.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      "This file is not valid JSON. Choose a mod list exported by MCSM."
    );
  }
  const result = v.safeParse(schema, value);
  if (!result.success)
    throw new Error(
      `Invalid mod list. Use an MCSM export (format version 1), with at most ${MAX_MOD_LIST_ENTRIES} mods and valid provider/project references.`
    );
  return result.output;
}

/** IDs are always portable; selected fields add human-readable details. */
export function createModList(
  mods: InstalledMod[],
  options: {
    fields: ModListField[];
    includeDependencies: boolean;
    environment?: ModList["environment"];
    createdAt?: string;
  }
): ModList {
  const fields = new Set(options.fields);
  const entries: ModListEntry[] = mods
    .filter((mod) => options.includeDependencies || !mod.dependency)
    .map((mod) => {
      const identity = installedModLinkIdentity(mod);
      const display = identity ?? mod.identities[0];
      const entry: ModListEntry = identity
        ? {
            provider: identity.provider,
            projectId: identity.projectId,
            dependency: mod.dependency,
          }
        : {
            provider: "manual",
            filename: mod.filename,
            dependency: mod.dependency,
          };
      if (fields.has("name") && display) entry.name = display.name;
      if (fields.has("filename")) entry.filename = mod.filename;
      if (fields.has("version") && identity) {
        entry.version = identity.version;
        if (entry.provider !== "manual") entry.versionId = identity.versionId;
      }
      if (fields.has("source")) entry.source = mod.source;
      if (fields.has("websiteUrl") && identity)
        entry.websiteUrl = identity.websiteUrl;
      if (fields.has("size")) entry.size = mod.size;
      if (fields.has("modifiedAt")) entry.modifiedAt = mod.modifiedAt;
      return entry;
    });
  const list: ModList = {
    format: "mcsm-mod-list",
    version: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    mods: entries,
  };
  if (fields.has("environment") && options.environment)
    list.environment = options.environment;
  return list;
}

export function modListEntryName(entry: ModListEntry) {
  return (
    entry.name ??
    entry.filename ??
    (entry.provider === "manual" ? "Manual upload" : entry.projectId)
  );
}
