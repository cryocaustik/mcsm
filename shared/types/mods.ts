export type ModProvider = "modrinth" | "curseforge";
export type ModOrigin = ModProvider | "manual" | "unknown";
export type ModSearchSort = "relevance" | "downloads" | "updated" | "newest";

export type ModInstallStage =
  | "search"
  | "identify"
  | "resolve"
  | "download"
  | "write";

/** Safe diagnostics shared with the browser; never include request headers or keys. */
export type ModInstallFailure = {
  code: string;
  message: string;
  provider: ModProvider;
  retryable: boolean;
  hint?: string;
  stage?: ModInstallStage;
  projectId?: string;
  filename?: string;
  host?: string;
  upstreamStatus?: number;
  networkCode?: string;
  requestId?: string;
};

export type ModProject = {
  provider: ModProvider;
  projectId: string;
  slug: string;
  name: string;
  description: string;
  iconUrl: string | null;
  websiteUrl: string;
  downloads: number;
};

export type ModIdentity = ModProject & { version: string; versionId: string };

export type InstalledMod = {
  filename: string;
  size: number;
  modifiedAt: string | null;
  /** Recorded acquisition of this exact file; independent of detected listings. */
  source: ModOrigin;
  /** Automatically installed as a dependency, or currently required by another mod. */
  dependency: boolean;
  /** Currently installed direct dependents, deduplicated by filename. */
  requiredBy: { filename: string; name: string }[];
  /** A file may be published on both providers; these are verified identities. */
  identities: ModIdentity[];
  managed: boolean;
};

export type ModInventory = {
  mods: InstalledMod[];
  warnings: string[];
  providers: { id: ModProvider; available: boolean; reason?: string }[];
};

export type ModSearchResponse = {
  hits: ModProject[];
  total: number;
  offset: number;
  loader: string;
  gameVersion: string;
};
