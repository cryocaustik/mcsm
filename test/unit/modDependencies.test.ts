import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attachModDependents } from "../../server/utils/mods/dependencies";
import type { ModOriginRecord } from "../../server/utils/mods/origins";
import type { ModProjectReference } from "../../server/utils/mods/types";
import { installed } from "../fixtures/mods";

const hash = (id: string) => createHash("sha1").update(id).digest("hex");
const ref = (projectId: string): ModProjectReference => ({
  provider: "modrinth",
  projectId,
  sha1: hash(projectId),
});
function record(
  id: string,
  overrides: Partial<ModOriginRecord> = {}
): ModOriginRecord {
  return {
    version: 1,
    directory: "mods",
    filename: `${id}.jar`,
    sha1: hash(id),
    source: "modrinth",
    project: ref(id),
    ...overrides,
  };
}
const hashes = new Map(
  ["a", "b", "c", "d"].map((id) => [`${id}.jar`, hash(id)])
);

describe("installed mod dependency relationships", () => {
  it.each(["modrinth", "curseforge"] as const)(
    "lists each direct dependent once for %s, including shared and nested dependencies",
    (provider) => {
      const reference = (projectId: string) => ({
        ...ref(projectId),
        provider,
      });
      const mods = ["a", "b", "c", "d"].map((id) => installed(id, provider));
      const result = attachModDependents(
        mods,
        {
          "a.jar": record("a", {
            dependencies: [reference("b"), reference("c"), reference("b")],
          }),
          "b.jar": record("b", {
            dependencies: [reference("c")],
            dependency: true,
          }),
          "c.jar": record("c", {
            dependencies: [reference("d")],
            dependency: true,
          }),
        },
        hashes
      );
      expect(result[0]?.dependency).toBe(false);
      expect(result[1]?.requiredBy).toEqual([
        { filename: "a.jar", name: "Mod a" },
      ]);
      expect(result[2]?.requiredBy).toEqual([
        { filename: "a.jar", name: "Mod a" },
        { filename: "b.jar", name: "Mod b" },
      ]);
      expect(result[3]?.requiredBy).toEqual([
        { filename: "c.jar", name: "Mod c" },
      ]);
      expect(result.slice(1).every((mod) => mod.dependency)).toBe(true);
    }
  );
  it("drops deleted dependents but retains automatic dependency history for unused jars", () => {
    const result = attachModDependents(
      [installed("b")],
      {
        "a.jar": record("a", { dependencies: [ref("b")] }),
        "b.jar": record("b", { dependency: true }),
      },
      hashes
    );
    expect(result[0]).toMatchObject({ dependency: true, requiredBy: [] });
  });
  it("tags a reused manual upload without changing its source, then clears the tag when no longer required", () => {
    const manual = { ...installed("b"), source: "manual" as const };
    const origins = {
      "a.jar": record("a", { dependencies: [ref("b")] }),
      "b.jar": record("b", { source: "manual", project: undefined }),
    };
    const result = attachModDependents(
      [installed("a"), manual],
      origins,
      hashes
    );
    expect(result[1]).toMatchObject({
      source: "manual",
      dependency: true,
      requiredBy: [{ filename: "a.jar", name: "Mod a" }],
    });
    expect(attachModDependents([manual], origins, hashes)[0]).toMatchObject({
      source: "manual",
      dependency: false,
      requiredBy: [],
    });
  });
  it("invalidates both dependency history and outgoing links when a file changes outside MCSM", () => {
    const result = attachModDependents(
      [installed("a"), installed("b")],
      {
        "a.jar": record("a", {
          sha1: hash("old"),
          dependency: true,
          dependencies: [ref("b")],
        }),
      },
      hashes
    );
    expect(
      result.every((mod) => !mod.dependency && !mod.requiredBy.length)
    ).toBe(true);
  });
  it("keeps project links across dependency updates that change filename and hash", () => {
    const newer = { ...installed("b"), filename: "b-2.jar" };
    const result = attachModDependents(
      [installed("a"), newer],
      {
        "a.jar": record("a", { dependencies: [ref("b")] }),
        "b-2.jar": record("b", {
          filename: newer.filename,
          sha1: hash("new"),
          dependency: true,
        }),
      },
      new Map([...hashes, [newer.filename, hash("new")]])
    );
    expect(result[1]?.requiredBy).toEqual([
      { filename: "a.jar", name: "Mod a" },
    ]);
  });
  it("links identical cross-provider files through their verified content hash", () => {
    const otherProvider = installed("123", "curseforge");
    const result = attachModDependents(
      [installed("a"), otherProvider],
      {
        "a.jar": record("a", { dependencies: [ref("b")] }),
      },
      new Map([...hashes, [otherProvider.filename, hash("b")]])
    );
    expect(result[1]?.requiredBy).toEqual([
      { filename: "a.jar", name: "Mod a" },
    ]);
  });
  it("never links unrelated project IDs across providers", () => {
    const result = attachModDependents(
      [installed("a"), installed("b", "curseforge")],
      {
        "a.jar": record("a", {
          dependencies: [{ provider: "modrinth", projectId: "b" }],
        }),
      },
      hashes
    );
    expect(result[1]).toMatchObject({ dependency: false, requiredBy: [] });
  });
  it("retains relationships using recorded projects when provider identification is unavailable", () => {
    const mods = [installed("a"), installed("b")].map((mod) => ({
      ...mod,
      identities: [],
    }));
    const result = attachModDependents(
      mods,
      {
        "a.jar": record("a", { dependencies: [ref("b")] }),
        "b.jar": record("b", { dependency: true }),
      },
      hashes
    );
    expect(result[1]?.requiredBy).toEqual([
      { filename: "a.jar", name: "a.jar" },
    ]);
  });
  it("handles cycles without displaying self-dependencies", () => {
    const result = attachModDependents(
      [installed("a"), installed("b")],
      {
        "a.jar": record("a", { dependencies: [ref("a"), ref("b")] }),
        "b.jar": record("b", { dependencies: [ref("a")] }),
      },
      hashes
    );
    expect(result[0]?.requiredBy).toEqual([
      { filename: "b.jar", name: "Mod b" },
    ]);
    expect(result[1]?.requiredBy).toEqual([
      { filename: "a.jar", name: "Mod a" },
    ]);
  });
  it("uses the recorded source's display name for cross-listed dependents", () => {
    const parent = {
      ...installed("a", "curseforge"),
      identities: [
        ...installed("other").identities,
        ...installed("a", "curseforge").identities,
      ],
    };
    const result = attachModDependents(
      [parent, installed("b")],
      {
        "a.jar": record("a", { dependencies: [ref("b")] }),
      },
      hashes
    );
    expect(result[1]?.requiredBy[0]?.name).toBe("Mod a");
  });
});
