import { apiError } from "../fixtures/mods";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCurseforgeSource,
  type CurseForgeFile,
} from "../../server/utils/mods/curseforge";
import { modrinthSource } from "../../server/utils/mods/modrinth";

const fetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("$fetch", fetch);
  vi.stubGlobal("createError", apiError);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetch.mockReset();
});
const options = {
  query: "map",
  loader: "fabric",
  gameVersion: "1.21.1",
  offset: 20,
  sort: "downloads" as const,
};
const cfProject = {
  id: 123,
  slug: "example",
  name: "Example",
  summary: "A mod",
  logo: null,
  downloadCount: 42,
};
const cfFile: CurseForgeFile = {
  id: 456,
  modId: 123,
  displayName: "Example 1.0",
  fileName: "example.jar",
  downloadUrl: "https://edge.forgecdn.net/example.jar",
  fileLength: 3,
  gameVersions: ["1.21.1", "Fabric"],
  hashes: [{ algo: 1, value: "a".repeat(40) }],
  dependencies: [
    { modId: 124, relationType: 3 },
    { modId: 125, relationType: 2 },
  ],
};

describe("CurseForge source", () => {
  const source = createCurseforgeSource("test-key");
  it("uses the Minecraft mods class, loader, version, pagination and provider sorting", async () => {
    fetch.mockResolvedValue({
      data: [cfProject],
      pagination: { totalCount: 41 },
    });
    const response = await source.search(options);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.curseforge.com/v1/mods/search",
      expect.objectContaining({
        headers: { "x-api-key": "test-key" },
        query: expect.objectContaining({
          gameId: 432,
          classId: 6,
          modLoaderType: 4,
          gameVersion: "1.21.1",
          index: 20,
          sortField: 6,
        }),
      })
    );
    expect(response.hits[0]).toMatchObject({
      provider: "curseforge",
      projectId: "123",
      websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/example",
    });
  });
  it("searches Bukkit plugins for Paper without a mod-loader filter", async () => {
    fetch.mockResolvedValue({
      data: [cfProject],
      pagination: { totalCount: 1 },
    });
    const response = await source.search({ ...options, loader: "paper" });
    expect(fetch.mock.calls[0]![1].query).toMatchObject({ classId: 5 });
    expect(fetch.mock.calls[0]![1].query).not.toHaveProperty("modLoaderType");
    expect(response.hits[0]?.websiteUrl).toContain("bukkit-plugins");
  });
  it("checks file compatibility and keeps only required dependencies", async () => {
    fetch.mockResolvedValue({
      data: [{ ...cfFile, gameVersions: ["1.20.1", "Forge"] }, cfFile],
    });
    const result = await source.resolve("123", "fabric", "1.21.1");
    expect(result).toMatchObject({
      projectId: "123",
      versionId: "456",
      dependencies: [{ projectId: "124" }],
    });
    expect(await source.resolve("123", "forge", "1.21.1")).toBeNull();
  });
  it("does not fabricate a download URL when the author restricts distribution", async () => {
    fetch.mockResolvedValue({ data: [{ ...cfFile, downloadUrl: null }] });
    expect(await source.resolve("123", "fabric", "1.21.1")).toMatchObject({
      downloadUrl: null,
    });
  });
  it("requires SHA-1 agreement as well as an exact fingerprint result", async () => {
    fetch
      .mockResolvedValueOnce({
        data: { exactMatches: [{ id: 123, file: cfFile }] },
      })
      .mockResolvedValueOnce({ data: [cfProject] });
    const response = await source.identify([
      { filename: "verified.jar", sha1: "a".repeat(40), fingerprint: 123 },
      { filename: "collision.jar", sha1: "b".repeat(40), fingerprint: 123 },
    ]);
    expect(Object.keys(response)).toEqual(["verified.jar"]);
    expect(response["verified.jar"]).toMatchObject({
      provider: "curseforge",
      projectId: "123",
      versionId: "456",
    });
  });
  it("redacts upstream failures rather than exposing request headers or keys", async () => {
    fetch.mockRejectedValue({
      statusCode: 403,
      message: "secret test-key",
      headers: { "x-api-key": "test-key" },
    });
    try {
      await source.search(options);
      expect.fail("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("rejected the API key");
      expect(JSON.stringify(error)).not.toContain("test-key");
    }
  });
});

describe("Modrinth source", () => {
  const mrVersion = {
    id: "version1",
    project_id: "project1",
    version_number: "1.0",
    loaders: ["fabric"],
    game_versions: ["1.21.1"],
    files: [
      {
        filename: "example.jar",
        primary: true,
        url: "https://cdn.modrinth.com/example.jar",
        size: 3,
        hashes: { sha1: "a".repeat(40), sha512: "" },
      },
    ],
    dependencies: [
      {
        project_id: null,
        version_id: "pinned-dep",
        dependency_type: "required",
      },
    ],
  };
  it("preserves server compatibility facets and sort order", async () => {
    fetch.mockResolvedValue({ hits: [], total_hits: 0 });
    await modrinthSource.search(options);
    const query = fetch.mock.calls[0]![1].query;
    expect(query).toMatchObject({ index: "downloads", offset: "20" });
    expect(JSON.parse(query.facets)).toEqual([
      ["categories:fabric"],
      ["versions:1.21.1"],
      ["server_side:optional", "server_side:required"],
    ]);
  });
  it("resolves version-only dependency references and verifies pinned compatibility", async () => {
    fetch.mockResolvedValue(mrVersion);
    expect(
      await modrinthSource.resolve(null, "fabric", "1.21.1", "version1")
    ).toMatchObject({
      dependencies: [{ projectId: null, versionId: "pinned-dep" }],
    });
    expect(
      await modrinthSource.resolve(null, "forge", "1.21.1", "version1")
    ).toBeNull();
    expect(
      await modrinthSource.resolve(
        "different-project",
        "fabric",
        "1.21.1",
        "version1"
      )
    ).toBeNull();
  });
  it("identifies manually uploaded files and includes project metadata", async () => {
    fetch
      .mockResolvedValueOnce({ ["a".repeat(40)]: mrVersion })
      .mockResolvedValueOnce([
        { id: "project1", slug: "example", title: "Example", icon_url: null },
      ]);
    const response = await modrinthSource.identify([
      { filename: "uploaded.jar", sha1: "a".repeat(40), fingerprint: 1 },
    ]);
    expect(response["uploaded.jar"]).toMatchObject({
      provider: "modrinth",
      name: "Example",
      projectId: "project1",
      version: "1.0",
      websiteUrl: "https://modrinth.com/mod/example",
    });
  });
});
