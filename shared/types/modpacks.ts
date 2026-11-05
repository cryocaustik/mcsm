export type ModpackPlatform = "curseforge" | "modrinth" | "ftb";
export type ModpackMode = "pinned" | "latest";
export type PackVersion = {
  id: string;
  name: string;
  versionNumber?: string;
  releasedAt: string | null;
  channel: "release" | "beta" | "alpha";
  minecraft: string[];
};
export type PackCatalog = {
  platform: ModpackPlatform;
  id: string;
  slug: string;
  name: string;
  url: string;
  iconUrl: string | null;
  versions: PackVersion[];
};
export type InstalledPack = {
  platform: ModpackPlatform;
  projectId: string | null;
  slug: string | null;
  name: string | null;
  versionId: string;
  versionName: string | null;
  minecraft: string | null;
  loader: string | null;
  loaderVersion: string | null;
  files: string[];
  hashes: Record<string, string>;
  receipt: boolean;
};
export type PackOperation = {
  state:
    | "backing-up"
    | "restoring"
    | "recreating"
    | "installing"
    | "complete"
    | "failed";
  target: string;
  startedAt: number;
  backupId?: number;
  error?: string;
};
export type ModpackStatus = {
  containerAvailable?: boolean;
  platform: ModpackPlatform;
  mode: ModpackMode;
  requestedVersion: string | null;
  installed: InstalledPack | null;
  catalog: PackCatalog | null;
  latest: PackVersion | null;
  updateAvailable: boolean;
  ready: boolean;
  operation: PackOperation | null;
  warnings: string[];
};
