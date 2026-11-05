import {
  packPlatform,
  packMode,
  newestPackVersion,
  packHasUpdate,
} from "../../shared/utils/modpacks";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { pack } from "tar-stream";
import * as v from "valibot";
import {
  serverConfigSchema,
  type ServerConfig,
} from "../../server/schema/server.schema";
import { defaultCreateForm } from "../../app/composables/create-form";
import {
  parseInstalledPack,
  managedPackPath,
  readInstalledPack,
  invalidateInstalledPack,
  assertPackOwnedFilesMutable as assertPackFilesMutable,
} from "../../server/utils/modpacks/installed";
import {
  getPackCatalog,
  assertPackSelectionUnchanged,
  readCachedPackCatalog,
  resolvePackConfiguration,
} from "../../server/utils/modpacks/catalog";
import {
  serverGameVersion,
  resolveServerLoader,
} from "../../server/utils/minecraft/modrinth-api";
import { buildServerSpec } from "../../server/utils/serverSpec";
import { apiError } from "../fixtures/mods";

const fetch = vi.fn(),
  getArchive = vi.fn();
const config = (patch: Partial<ServerConfig> = {}): ServerConfig =>
  v.parse(serverConfigSchema, {
    ...defaultCreateForm(),
    type: "AUTO_CURSEFORGE",
    name: "Test",
    domain: "example.test",
    CF_SLUG: "test-pack",
    ...patch,
  });
const cf = {
  modId: 42,
  fileId: 101,
  slug: "test-pack",
  modpackName: "Test pack",
  modpackVersion: "1.0",
  minecraftVersion: "1.20.1",
  modLoaderId: "neoforge-47.1.84",
  files: ["mods/base.jar", "config/base.toml"],
};
const env =
  'MODPACK_NAME="Test pack"\nMODPACK_VERSION="1.0"\nVERSION="1.20.1"\n';
const ftb = {
  id: 119,
  name: "FTB pack",
  versionName: "1.16.0",
  versionId: 12252,
  modPackTargets: {
    mcVersion: "1.20.1",
    modLoader: { name: "neoforge", version: "47.1.84" },
  },
  files: [
    {
      path: "./mods/",
      name: "base.jar",
      url: "https://files.feed-the-beast.com/base.jar",
      hash: "a".repeat(40),
      hash_type: "sha1",
    },
  ],
};
function archive(name: string, data: string) {
  const tar = pack();
  tar.entry({ name }, data);
  tar.finalize();
  return tar;
}
function installer(manifest = cf, result = env) {
  getArchive.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith(".curseforge-manifest.json")
      ? archive(".curseforge-manifest.json", JSON.stringify(manifest))
      : archive(".install-curseforge.env", result)
  );
}
beforeEach(() => {
  invalidateInstalledPack("server");
  vi.stubGlobal("createError", apiError);
  vi.stubGlobal("$fetch", fetch);
  vi.stubGlobal("useDocker", () => ({
    docker: { getContainer: () => ({ getArchive }) },
  }));
  vi.stubGlobal("useSecrets", () => ({
    get: async () => "test-key",
    getAll: async () => ({ CURSEFORGE_API_KEY: "test-key" }),
  }));
  vi.stubGlobal("useRuntimeConfig", () => ({
    docker: { image: "itzg/minecraft-server" },
  }));
  installer();
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("installer metadata contracts", () => {
  it("reads exact CF project/file IDs, the runtime versions and installer-owned paths", () => {
    expect(
      parseInstalledPack("curseforge", JSON.stringify(cf), env)
    ).toMatchObject({
      projectId: "42",
      versionId: "101",
      versionName: "1.0",
      minecraft: "1.20.1",
      loader: "neoforge",
      loaderVersion: "47.1.84",
      receipt: true,
      files: ["mods/base.jar", "config/base.toml"],
      hashes: {},
    });
  });
  it("does not certify a partial CF installation with a missing or older results file", () => {
    expect(
      parseInstalledPack("curseforge", JSON.stringify(cf), null).receipt
    ).toBe(false);
    expect(
      parseInstalledPack(
        "curseforge",
        JSON.stringify(cf),
        env.replace("1.0", "0.9")
      ).receipt
    ).toBe(false);
  });
  it("reads Modrinth's API version ID separately from the human-facing version name", () => {
    const manifest = {
      projectSlug: "test-pack",
      versionId: "aB12cd34",
      dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" },
      files: ["mods/base.jar"],
    };
    const installed = parseInstalledPack(
      "modrinth",
      JSON.stringify(manifest),
      'MODPACK_NAME="Test pack"\nMODPACK_VERSION="2.0"\nVERSION="1.21.1"'
    );
    expect(installed).toMatchObject({
      versionId: "aB12cd34",
      versionName: "2.0",
      minecraft: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.9",
      receipt: true,
    });
  });
  it("reads FTB's hash-bearing file records and requires a matching success marker", () => {
    const installed = parseInstalledPack(
      "ftb",
      JSON.stringify(ftb),
      "119=12252\n"
    );
    expect(installed).toMatchObject({
      projectId: "119",
      versionId: "12252",
      versionName: "1.16.0",
      receipt: true,
      files: ["mods/base.jar"],
      hashes: { "mods/base.jar": "a".repeat(40) },
    });
    expect(
      parseInstalledPack("ftb", JSON.stringify(ftb), "119=12251").receipt
    ).toBe(false);
  });
  it.each([
    "../mods/base.jar",
    "/data/mods/base.jar",
    "mods/../base.jar",
    "mods\\base.jar",
    "mods/\0base.jar",
    "mods//base.jar",
  ])("rejects unsafe manifest paths %j", (path) => {
    expect(managedPackPath(path)).toBeNull();
    expect(() =>
      parseInstalledPack(
        "curseforge",
        JSON.stringify({ ...cf, files: [path] }),
        env
      )
    ).toThrow();
  });
  it("treats shell-looking results as text without evaluating them", () => {
    const result = parseInstalledPack(
      "modrinth",
      JSON.stringify({
        projectSlug: "test",
        versionId: "12345678",
        dependencies: { minecraft: "1.20.1", forge: "47.0.0" },
        files: [],
      }),
      'MODPACK_NAME="$(touch /tmp/should-not-exist)"\nMODPACK_VERSION="1"\nVERSION="1.20.1"'
    );
    expect(result.name).toBe("$(touch /tmp/should-not-exist)");
  });
  it("reads only the selected platform's metadata files, coalesces reads, and supports stopped containers", async () => {
    const results = await Promise.all([
      readInstalledPack("server", config()),
      readInstalledPack("server", config()),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(getArchive).toHaveBeenCalledTimes(2);
    expect(getArchive.mock.calls.map(([request]) => request.path)).toEqual([
      "/data/.curseforge-manifest.json",
      "/data/.install-curseforge.env",
    ]);
  });
  it("returns pending metadata when a pack has not installed and retries malformed metadata", async () => {
    getArchive.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readInstalledPack("server", config())).toBeNull();
    invalidateInstalledPack("server");
    getArchive.mockImplementationOnce(async () =>
      archive(".curseforge-manifest.json", "not json")
    );
    await expect(readInstalledPack("server", config())).rejects.toThrow();
    installer();
    expect((await readInstalledPack("server", config()))?.versionId).toBe(
      "101"
    );
  });
  it("blocks per-file overwrite/delete/update of pack files while preserving custom additions", async () => {
    const server = {
      id: "server",
      config: config({ CF_FILE_ID: "101" }),
      running: false,
    };
    await expect(
      assertPackFilesMutable("server", server, ["base.jar"])
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      assertPackFilesMutable("server", server, ["extra.jar"])
    ).resolves.toBeUndefined();
    await expect(
      assertPackFilesMutable(
        "server",
        { ...server, config: config({ CF_FILE_ID: "102" }) },
        ["extra.jar"]
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    installer(cf, 'MODPACK_NAME="Older pack"');
    await expect(
      assertPackFilesMutable("server", server, ["extra.jar"])
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("uses installed Minecraft and loader versions instead of latest or stale loader directories", async () => {
    expect(await serverGameVersion(config({ VERSION: null }), "server")).toBe(
      "1.20.1"
    );
    expect(
      await resolveServerLoader({
        id: "server",
        config: config(),
        volume: "volume",
      })
    ).toBe("neoforge");
    expect(getArchive).toHaveBeenCalledTimes(2);
  });
});

describe("provider version catalogs and pinning", () => {
  const project = {
    id: 42,
    slug: "test-pack",
    name: "Test pack",
    logo: { thumbnailUrl: "https://example.com/pack.png" },
  };
  const files = [
    {
      id: 102,
      displayName: "2.0",
      fileDate: "2026-11-02",
      releaseType: 1,
      gameVersions: ["1.21.1"],
    },
    {
      id: 103,
      displayName: "3.0 beta",
      fileDate: "2026-11-03",
      releaseType: 2,
    },
    {
      id: 104,
      displayName: "Server zip",
      fileDate: "2026-11-04",
      releaseType: 1,
      isServerPack: true,
    },
  ];
  function cfApi() {
    fetch.mockImplementation(async (url: string) =>
      url.includes("/files") ? { data: files } : { data: [project] }
    );
  }
  it("pins new configurations to a concrete stable pack file ID and excludes server packs", async () => {
    cfApi();
    const resolved = await resolvePackConfiguration(config());
    expect(resolved.CF_FILE_ID).toBe("102");
    expect(resolved.MODPACK_UPDATE_MODE).toBe("pinned");
    const catalog = await getPackCatalog(config());
    expect(catalog.versions.map((version) => version.id)).toEqual([
      "103",
      "102",
    ]);
    expect(newestPackVersion(catalog.versions)?.id).toBe("102");
  });
  it("keeps existing unpinned configurations following latest until explicitly changed", async () => {
    const legacy = config({ MODPACK_UPDATE_MODE: undefined, CF_FILE_ID: null });
    expect(packMode(legacy)).toBe("latest");
    expect(await resolvePackConfiguration(legacy)).toEqual(legacy);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      packMode(config({ MODPACK_UPDATE_MODE: undefined, CF_FILE_ID: "101" }))
    ).toBe("pinned");
  });
  it("clears explicit pins in follow-latest mode without querying a provider", async () => {
    const resolved = await resolvePackConfiguration(
      config({ MODPACK_UPDATE_MODE: "latest", CF_FILE_ID: "101" })
    );
    expect(resolved.CF_FILE_ID).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("normalizes Modrinth versions and preserves exact provider IDs", async () => {
    fetch
      .mockResolvedValueOnce({
        id: "project1",
        slug: "pack",
        title: "Pack",
        project_type: "modpack",
        icon_url: null,
      })
      .mockResolvedValueOnce([
        {
          id: "version1",
          name: "Pack 2",
          version_number: "2",
          date_published: "2026-11-01",
          version_type: "release",
          game_versions: ["1.21.1"],
          files: [{ filename: "pack.mrpack" }],
        },
      ]);
    const resolved = await resolvePackConfiguration(
      config({
        type: "MODRINTH",
        MODRINTH_MODPACK: "https://modrinth.com/modpack/pack",
        MODRINTH_VERSION: null,
      })
    );
    expect(resolved.MODRINTH_VERSION).toBe("version1");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.modrinth.com/v2/project/pack"
    );
  });
  it("uses the FTB API's names, release dates and targets for version discovery", async () => {
    fetch.mockResolvedValue({
      status: "success",
      id: 119,
      name: "FTB pack",
      versions: [
        { id: 9, name: "Older", type: "release", updated: 10 },
        {
          id: 2,
          name: "Newer",
          type: "release",
          updated: 20,
          targets: [{ name: "minecraft", version: "1.20.1", type: "game" }],
        },
      ],
    });
    const resolved = await resolvePackConfiguration(
      config({ type: "FTBA", FTB_MODPACK_ID: "119" })
    );
    expect(resolved.FTB_MODPACK_VERSION_ID).toBe("2");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.feed-the-beast.com/v1/modpacks/public/modpack/119"
    );
  });
  it("compares published dates instead of numeric or semantic ordering of opaque IDs", () => {
    const older = {
      id: "999",
      name: "10.0",
      releasedAt: "2026-01-01",
      channel: "release" as const,
      minecraft: [],
    };
    const newer = { ...older, id: "2", name: "1.0", releasedAt: "2026-02-01" };
    const installed = parseInstalledPack(
      "curseforge",
      JSON.stringify({ ...cf, fileId: 999 }),
      env
    );
    expect(packHasUpdate(installed, newer, [older, newer])).toBe(true);
    expect(
      packHasUpdate({ ...installed, versionId: "2" }, older, [older, newer])
    ).toBe(false);
    expect(packHasUpdate(installed, newer, [newer])).toBe(false);
  });
  it("passes resolved pins to itzg and persists the same configuration in its labels", async () => {
    cfApi();
    const spec = await buildServerSpec(config());
    expect(spec.env).toMatchObject({
      TYPE: "AUTO_CURSEFORGE",
      CF_SLUG: "test-pack",
      CF_FILE_ID: "102",
    });
    expect(JSON.parse(spec.labels["mcsm.config"]!).CF_FILE_ID).toBe("102");
  });
  it("recognizes the container's explicit MODPACK_PLATFORM alias", () => {
    expect(
      packPlatform(
        config({
          type: "FORGE",
          customEnv: [{ key: "MODPACK_PLATFORM", value: "FTBA" }],
        })
      )
    ).toBe("ftb");
  });
});

describe("pack configuration boundaries", () => {
  it("allows ordinary settings saves while preserving legacy follow-latest policy", () => {
    const previous = config({
      MODPACK_UPDATE_MODE: undefined,
      CF_FILE_ID: null,
    });
    expect(() =>
      assertPackSelectionUnchanged(previous, {
        ...previous,
        MODPACK_UPDATE_MODE: "latest",
        memory: "4G",
      })
    ).not.toThrow();
  });
  it("requires the backup workflow for version, policy and project changes", () => {
    const previous = config({ CF_FILE_ID: "101" });
    for (const patch of [
      { CF_FILE_ID: "102" },
      { MODPACK_UPDATE_MODE: "latest" as const },
      { CF_SLUG: "other-pack" },
    ]) {
      expect(() =>
        assertPackSelectionUnchanged(previous, { ...previous, ...patch })
      ).toThrow(/Mods & Plugins/);
    }
  });
  it("reads cached pack metadata without waiting for the provider", async () => {
    await readCachedPackCatalog(config());
    expect(fetch).not.toHaveBeenCalled();
  });
});
