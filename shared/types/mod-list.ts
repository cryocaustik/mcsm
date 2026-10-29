import type { ModOrigin, ModProvider } from "./mods";

export type ModListDetails = {
  name?: string;
  filename?: string;
  version?: string;
  source?: ModOrigin;
  websiteUrl?: string;
  size?: number;
  modifiedAt?: string | null;
};
export type ModListDownload = ModListDetails & {
  provider: ModProvider;
  projectId: string;
  versionId?: string;
  dependency: boolean;
};
export type ModListManual = ModListDetails & {
  provider: "manual";
  filename: string;
  dependency: boolean;
};
export type ModListEntry = ModListDownload | ModListManual;
export type ModList = {
  format: "mcsm-mod-list";
  version: 1;
  createdAt: string;
  environment?: { name?: string; loader?: string; minecraftVersion?: string };
  mods: ModListEntry[];
};
export type ModListField = keyof ModListDetails | "environment";
export type ModInstallResult = {
  added: { filename: string; version_number: string; dependency: boolean }[];
  restarted: boolean;
  alreadyInstalled?: boolean;
};
