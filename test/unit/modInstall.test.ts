import { apiError } from "../fixtures/mods";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadModPlan,
  planModInstall,
  withModInstallLock,
} from "../../server/utils/mods/install";
import { downloadModFile } from "../../server/utils/mods/download";
import type { ModSource } from "../../server/utils/mods/types";
import { installed, version } from "../fixtures/mods";

vi.mock("../../server/utils/mods/download", () => ({
  downloadModFile: vi.fn(async (file) => ({
    name: file.filename,
    data: new Uint8Array([1, 2, 3]),
  })),
}));
afterEach(() => vi.clearAllMocks());
function source(resolve: ModSource["resolve"]): ModSource {
  return { id: "modrinth", resolve, search: vi.fn(), identify: vi.fn() };
}

describe("mod installation planning", () => {
  it("rejects an installed project before resolving a newer version", async () => {
    const resolve = vi.fn();
    await expect(
      planModInstall(source(resolve), "a", "fabric", "1.21.1", [installed("a")])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects a slug that resolves to an already installed project ID", async () => {
    await expect(
      planModInstall(
        source(async () => version("a")),
        "slug",
        "fabric",
        "1.21.1",
        [installed("a")]
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("handles cycles and shared dependencies without downloading installed dependencies", async () => {
    const resolve = vi.fn(async (id) =>
      version(id!, {
        dependencies:
          id === "a"
            ? [{ projectId: "b" }, { projectId: "c" }]
            : [{ projectId: "a" }],
      })
    );
    const plan = await planModInstall(
      source(resolve),
      "a",
      "fabric",
      "1.21.1",
      [installed("c")]
    );
    expect(plan.map((file) => file.projectId)).toEqual(["a", "b"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(plan[0]?.resolvedDependencies).toEqual([
      { provider: "modrinth", projectId: "b", sha1: "a".repeat(40) },
      { provider: "modrinth", projectId: "c" },
    ]);
    expect(plan[1]?.resolvedDependencies).toEqual([
      { provider: "modrinth", projectId: "a", sha1: "a".repeat(40) },
    ]);
  });
  it.each(["modrinth", "curseforge"] as const)(
    "records reused manual dependencies and their hashes for %s without redownloading them",
    async (provider) => {
      const resolve = vi.fn(async () =>
        version("a", { provider, dependencies: [{ projectId: "b" }] })
      );
      const dependency = {
        ...installed("b", provider),
        source: "manual" as const,
      };
      const plan = await planModInstall(
        { ...source(resolve), id: provider },
        "a",
        "fabric",
        "1.21.1",
        [dependency],
        [
          {
            filename: dependency.filename,
            sha1: "b".repeat(40),
            fingerprint: 1,
          },
        ]
      );
      expect(plan).toHaveLength(1);
      expect(plan[0]?.resolvedDependencies).toEqual([
        { provider, projectId: "b", sha1: "b".repeat(40) },
      ]);
      expect(dependency.source).toBe("manual");
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  );
  it("resolves pinned version-only dependencies into canonical project links", async () => {
    const resolve = vi.fn(async (id, _loader, _game, pin) =>
      id === "a"
        ? version("a", {
            dependencies: [{ projectId: null, versionId: "b-v1" }],
          })
        : version("b", { versionId: pin })
    );
    const plan = await planModInstall(
      source(resolve),
      "a",
      "fabric",
      "1.21.1",
      []
    );
    expect(plan[0]?.resolvedDependencies).toEqual([
      { provider: "modrinth", projectId: "b", sha1: "a".repeat(40) },
    ]);
    expect(plan.map((mod) => mod.projectId)).toEqual(["a", "b"]);
  });
  it("retains shared and nested links while planning each dependency only once", async () => {
    const resolve = vi.fn(async (id) =>
      version(id!, {
        dependencies: (id === "a" ? ["b", "c"] : id === "b" ? ["c"] : []).map(
          (projectId) => ({ projectId })
        ),
      })
    );
    const plan = await planModInstall(
      source(resolve),
      "a",
      "fabric",
      "1.21.1",
      []
    );
    expect(plan.map((mod) => mod.projectId)).toEqual(["a", "b", "c"]);
    expect(plan[0]?.resolvedDependencies.map((ref) => ref.projectId)).toEqual([
      "b",
      "c",
    ]);
    expect(plan[1]?.resolvedDependencies.map((ref) => ref.projectId)).toEqual([
      "c",
    ]);
    expect(resolve).toHaveBeenCalledTimes(3);
  });
  it("fails clearly when a required dependency has no compatible build", async () => {
    await expect(
      planModInstall(
        source(async (id) =>
          id === "a"
            ? version("a", { dependencies: [{ projectId: "missing" }] })
            : null
        ),
        "a",
        "fabric",
        "1.21.1",
        []
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("rejects conflicting pinned dependency versions", async () => {
    const resolve: ModSource["resolve"] = async (id, _loader, _game, pin) =>
      id === "a"
        ? version("a", {
            dependencies: [
              { projectId: "b", versionId: "one" },
              { projectId: "b", versionId: "two" },
            ],
          })
        : version(id!, { versionId: pin! });
    await expect(
      planModInstall(source(resolve), "a", "fabric", "1.21.1", [])
    ).rejects.toThrow("conflicting versions");
  });
  it("rejects an installed dependency that disagrees with a pinned version", async () => {
    await expect(
      planModInstall(
        source(async () =>
          version("a", {
            dependencies: [{ projectId: "b", versionId: "other-version" }],
          })
        ),
        "a",
        "fabric",
        "1.21.1",
        [installed("b")]
      )
    ).rejects.toThrow("does not match");
  });
  it("bounds very large dependency graphs", async () => {
    const resolve: ModSource["resolve"] = async (id) =>
      version(id!, { dependencies: [{ projectId: String(Number(id) + 1) }] });
    await expect(
      planModInstall(source(resolve), "0", "fabric", "1.21.1", [])
    ).rejects.toThrow("50-project limit");
  });
});

describe("download planning", () => {
  const signature = {
    filename: "other-source.jar",
    sha1: "a".repeat(40),
    fingerprint: 0,
  };
  it("blocks identical content from another source before downloading", async () => {
    await expect(
      downloadModPlan([version("a")], [signature], "modrinth")
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(downloadModFile).not.toHaveBeenCalled();
  });
  it("blocks a filename collision with different content", async () => {
    await expect(
      downloadModPlan(
        [version("a", { filename: signature.filename, sha1: "b".repeat(40) })],
        [signature],
        "modrinth"
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(downloadModFile).not.toHaveBeenCalled();
  });
  it("skips exact installed dependencies and describes only new files", async () => {
    const result = await downloadModPlan(
      [version("a", { sha1: "b".repeat(40) }), version("dep")],
      [signature],
      "modrinth"
    );
    expect(result.added).toEqual([
      { filename: "a.jar", version_number: "1.0", dependency: false },
    ]);
    expect(downloadModFile).toHaveBeenCalledTimes(1);
  });
  it("caps the combined install size", async () => {
    await expect(
      downloadModPlan(
        [version("a", { size: 301 * 1024 * 1024 })],
        [],
        "modrinth"
      )
    ).rejects.toMatchObject({ statusCode: 413 });
  });
  it.each(["modrinth", "curseforge"] as const)(
    "persists project links and automatic dependency status on %s downloads",
    async (provider) => {
      const dependencies = [{ provider, projectId: "b", sha1: "b".repeat(40) }];
      const result = await downloadModPlan(
        [
          { ...version("a", { provider }), resolvedDependencies: dependencies },
          {
            ...version("b", { provider, sha1: "b".repeat(40) }),
            resolvedDependencies: [],
          },
        ],
        [],
        provider
      );
      expect(result.jars.map((jar) => jar.metadata)).toEqual([
        {
          project: { provider, projectId: "a" },
          dependencies,
          dependency: false,
        },
        {
          project: { provider, projectId: "b" },
          dependencies: [],
          dependency: true,
        },
      ]);
    }
  );
});

describe("install serialization", () => {
  it("blocks concurrent requests for one volume, releasing the lock after failure", async () => {
    let release!: () => void;
    const first = withModInstallLock(
      "volume",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await expect(
      withModInstallLock("volume", async () => {})
    ).rejects.toMatchObject({ statusCode: 409 });
    release();
    await first;
    await expect(
      withModInstallLock("volume", async () => {
        throw new Error("fail");
      })
    ).rejects.toThrow("fail");
    await expect(withModInstallLock("volume", async () => "ok")).resolves.toBe(
      "ok"
    );
  });
});

beforeEach(() => vi.stubGlobal("createError", apiError));
