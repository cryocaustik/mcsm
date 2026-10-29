import type {
  ModIdentity,
  ModProject,
  ModProvider,
  ModSearchSort,
} from "../../../shared/types/mods";

export type ModFileSignature = {
  filename: string;
  sha1: string;
  fingerprint: number;
};

export type ModVersion = {
  provider: ModProvider;
  projectId: string;
  versionId: string;
  version: string;
  filename: string;
  downloadUrl: string | null;
  size: number;
  sha1: string;
  dependencies: { projectId: string | null; versionId?: string | null }[];
};

export type ModProjectReference = {
  provider: ModProvider;
  projectId: string;
  /** Artifact fallback for cross-listed files and provider outages. */
  sha1?: string;
};

export type ModInstallMetadata = {
  project?: ModProjectReference;
  dependencies?: ModProjectReference[];
  dependency?: boolean;
};

export type PlannedModVersion = ModVersion & {
  resolvedDependencies: ModProjectReference[];
  /** Import can retain the current root while repairing its dependencies. */
  installedFilename?: string;
};

export type ModSearchOptions = {
  query: string;
  loader: string;
  gameVersion: string;
  offset: number;
  sort: ModSearchSort;
};

export interface ModSource {
  id: ModProvider;
  search(
    options: ModSearchOptions
  ): Promise<{ hits: ModProject[]; total: number }>;
  resolve(
    projectId: string | null,
    loader: string,
    gameVersion: string,
    versionId?: string | null
  ): Promise<ModVersion | null>;
  identify(files: ModFileSignature[]): Promise<Record<string, ModIdentity>>;
}
