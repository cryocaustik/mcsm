import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modrinthUpdateMetadata } from "../../server/utils/mods/modrinth";
import {
  getModrinthVersion,
  type ModrinthVersion,
} from "../../server/utils/minecraft/modrinth-api";
import type { ModOriginRecord } from "../../server/utils/mods/origins";
import { apiError } from "../fixtures/mods";

vi.mock("../../server/utils/minecraft/modrinth-api", () => ({
  getModrinthVersion: vi.fn(),
}));
beforeEach(() => vi.stubGlobal("createError", apiError));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const hash = "a".repeat(40);
const previous: ModOriginRecord = {
  version: 1,
  directory: "mods",
  filename: "old.jar",
  sha1: hash,
  source: "modrinth",
  project: { provider: "modrinth", projectId: "a" },
  dependency: true,
  dependencies: [
    { provider: "modrinth", projectId: "b", sha1: "b".repeat(40) },
    { provider: "modrinth", projectId: "removed" },
  ],
};
const newest: ModrinthVersion = {
  id: "a-v2",
  project_id: "a",
  version_number: "2",
  name: "A 2",
  files: [],
  dependencies: [
    { project_id: "b", version_id: null, dependency_type: "required" },
    { project_id: "new", version_id: null, dependency_type: "required" },
    { project_id: "optional", version_id: null, dependency_type: "optional" },
    { project_id: "embedded", version_id: null, dependency_type: "embedded" },
  ],
};

describe("dependency metadata during Modrinth updates", () => {
  it("preserves automatic dependency history, refreshes required links and drops obsolete or optional edges", async () => {
    const metadata = await modrinthUpdateMetadata(newest, previous, hash);
    expect(metadata).toEqual({
      project: { provider: "modrinth", projectId: "a" },
      dependency: true,
      dependencies: [
        { provider: "modrinth", projectId: "b", sha1: "b".repeat(40) },
        { provider: "modrinth", projectId: "new" },
      ],
    });
    expect(getModrinthVersion).not.toHaveBeenCalled();
  });
  it("does not inherit dependency history or hash fallbacks from a replaced file", async () => {
    const metadata = await modrinthUpdateMetadata(
      newest,
      previous,
      "c".repeat(40)
    );
    expect(metadata.dependency).toBe(false);
    expect(metadata.dependencies?.[0]).toEqual({
      provider: "modrinth",
      projectId: "b",
    });
  });
  it("tracks required relationships for previously untracked mods", async () => {
    const metadata = await modrinthUpdateMetadata(newest, undefined, hash);
    expect(metadata.dependency).toBe(false);
    expect(metadata.dependencies?.map((ref) => ref.projectId)).toEqual([
      "b",
      "new",
    ]);
  });
  it("preserves automatic dependency status when updating a CurseForge download through Modrinth", async () => {
    const metadata = await modrinthUpdateMetadata(
      newest,
      {
        ...previous,
        source: "curseforge",
        project: { provider: "curseforge", projectId: "123" },
      },
      hash
    );
    expect(metadata).toMatchObject({
      dependency: true,
      project: { provider: "modrinth", projectId: "a" },
    });
  });
  it("resolves and deduplicates version-only dependency references", async () => {
    vi.mocked(getModrinthVersion).mockResolvedValue({
      ...newest,
      project_id: "b",
      files: [
        {
          filename: "b.jar",
          primary: true,
          url: "https://cdn.modrinth.com/b.jar",
          size: 3,
          hashes: { sha1: "b".repeat(40), sha512: "" },
        },
      ],
    });
    const metadata = await modrinthUpdateMetadata(
      {
        ...newest,
        dependencies: [
          {
            project_id: null,
            version_id: "b-pinned",
            dependency_type: "required",
          },
          ...newest.dependencies,
        ],
      },
      undefined,
      hash
    );
    expect(metadata.dependencies).toEqual([
      { provider: "modrinth", projectId: "b", sha1: "b".repeat(40) },
      { provider: "modrinth", projectId: "new" },
    ]);
    expect(getModrinthVersion).toHaveBeenCalledWith("b-pinned");
  });
  it("fails before writing when a required dependency cannot be identified", async () => {
    await expect(
      modrinthUpdateMetadata(
        {
          ...newest,
          dependencies: [
            { project_id: null, version_id: null, dependency_type: "required" },
          ],
        },
        previous,
        hash
      )
    ).rejects.toThrow("Could not identify a required dependency");
  });
});
