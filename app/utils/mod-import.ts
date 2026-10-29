import type {
  ModInstallResult,
  ModListDownload,
  ModListEntry,
} from "../../shared/types/mod-list";
import { modInstallFailure } from "../../shared/utils/mods";
import { errorMessage } from "./errors";

export type ModImportStatus =
  | "ready"
  | "installing"
  | "installed"
  | "repaired"
  | "skipped"
  | "failed"
  | "manual"
  | "unavailable";
export type ModImportRow = {
  entry: ModListEntry;
  status: ModImportStatus;
  message?: string;
  hint?: string;
  reference?: string;
  added?: number;
};

/** Install roots first so an explicit dependency entry cannot replace their pins. */
export async function runModImport(
  rows: ModImportRow[],
  options: {
    install: (entry: ModListDownload) => Promise<ModInstallResult>;
    shouldStop?: () => boolean;
    onResult?: (row: ModImportRow) => void;
  }
) {
  let added = 0;
  for (const row of [...rows].sort(
    (a, b) => Number(a.entry.dependency) - Number(b.entry.dependency)
  )) {
    if (options.shouldStop?.()) break;
    if (row.entry.provider === "manual") {
      row.status = "manual";
      continue;
    }
    row.status = "installing";
    row.message = row.hint = row.reference = undefined;
    row.added = 0;
    try {
      const result = await options.install(row.entry);
      added += result.added.length;
      row.added = result.added.length;
      row.status = result.alreadyInstalled
        ? result.added.length
          ? "repaired"
          : "skipped"
        : "installed";
    } catch (error) {
      const failure = modInstallFailure(error);
      row.status = "failed";
      row.message = errorMessage(error, "Could not install this mod.");
      row.hint = failure?.hint;
      row.reference = failure?.requestId;
    }
    options.onResult?.(row);
  }
  return { added };
}
