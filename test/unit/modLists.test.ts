import { describe, expect, it } from "vitest";
import {
  createModList,
  parseModList,
  MAX_MOD_LIST_BYTES,
  MAX_MOD_LIST_ENTRIES,
} from "../../shared/utils/mod-list";
import { identity, installed } from "../fixtures/mods";

const createdAt = "2026-10-28T00:00:00.000Z";
const base = { format: "mcsm-mod-list", version: 1, createdAt, mods: [] };
const options = {
  fields: [] as import("../../shared/types/mod-list").ModListField[],
  includeDependencies: true,
  createdAt,
};
const cf = {
  ...installed("123", "curseforge"),
  identities: [
    identity("a"),
    { ...identity("123", "curseforge"), versionId: "456" },
  ],
};

describe("portable mod lists", () => {
  it("exports the acquisition provider for cross-listed mods and retains the version when selected", () => {
    const list = createModList([cf], {
      ...options,
      fields: ["name", "version", "source", "websiteUrl"],
    });
    expect(list.mods[0]).toEqual({
      provider: "curseforge",
      projectId: "123",
      dependency: false,
      name: "Mod 123",
      version: "1.0",
      versionId: "456",
      source: "curseforge",
      websiteUrl: "https://example.com/123",
    });
    expect(parseModList(JSON.stringify(list))).toEqual(list);
  });
  it("keeps required references while omitting every optional field", () => {
    const list = createModList([installed("a")], options);
    expect(list.mods).toEqual([
      { provider: "modrinth", projectId: "a", dependency: false },
    ]);
    expect(parseModList(JSON.stringify(list))).toEqual(list);
  });
  it("excludes dependencies only when requested, leaving roots for the destination resolver", () => {
    const mods = [installed("a"), { ...installed("b"), dependency: true }];
    expect(
      createModList(mods, { ...options, includeDependencies: false }).mods
    ).toEqual([{ provider: "modrinth", projectId: "a", dependency: false }]);
    expect(createModList(mods, options).mods).toHaveLength(2);
  });
  it("uses a verified listing for recognized uploads but lists private jars for manual transfer", () => {
    const list = createModList(
      [
        { ...installed("a"), source: "manual" },
        { ...installed("private"), source: "manual", identities: [] },
      ],
      options
    );
    expect(list.mods).toEqual([
      { provider: "modrinth", projectId: "a", dependency: false },
      { provider: "manual", filename: "private.jar", dependency: false },
    ]);
    expect(parseModList(JSON.stringify(list))).toEqual(list);
  });
  it("does not silently switch providers when the recorded source cannot be identified", () => {
    const list = createModList(
      [{ ...cf, identities: [identity("a")] }],
      options
    );
    expect(list.mods[0]).toEqual({
      provider: "manual",
      filename: "123.jar",
      dependency: false,
    });
  });
  it("exports selected display fields and world information independently", () => {
    const mod = { ...installed("a"), modifiedAt: createdAt };
    const environment = {
      name: "World A",
      loader: "FABRIC",
      minecraftVersion: "1.21.1",
    };
    const list = createModList([mod], {
      ...options,
      fields: ["filename", "size", "modifiedAt", "environment"],
      environment,
    });
    expect(list.mods[0]).toEqual({
      provider: "modrinth",
      projectId: "a",
      dependency: false,
      filename: "a.jar",
      size: 3,
      modifiedAt: createdAt,
    });
    expect(list.environment).toEqual(environment);
    expect(
      createModList([mod], { ...options, environment }).environment
    ).toBeUndefined();
  });
  it("accepts a UTF-8 BOM and defaults omitted dependency flags", () => {
    expect(
      parseModList(
        "\uFEFF" +
          JSON.stringify({
            ...base,
            mods: [{ provider: "modrinth", projectId: "a" }],
          })
      ).mods[0]?.dependency
    ).toBe(false);
  });
  it.each([
    { ...base, version: 2 },
    { ...base, format: "other-list" },
    { ...base, mods: [{ provider: "curseforge", projectId: "not-an-id" }] },
    { ...base, mods: [{ provider: "modrinth", projectId: "" }] },
    { ...base, mods: [{ provider: "manual", filename: "../private.jar" }] },
    {
      ...base,
      mods: [
        {
          provider: "modrinth",
          projectId: "a",
          websiteUrl: "javascript:alert(1)",
        },
      ],
    },
  ])("rejects malformed references and unsupported list formats", (value) => {
    expect(() => parseModList(JSON.stringify(value))).toThrow(
      "Invalid mod list"
    );
  });
  it("bounds both file size and entry count", () => {
    expect(() => parseModList(" ".repeat(MAX_MOD_LIST_BYTES + 1))).toThrow(
      "2 MB"
    );
    expect(() =>
      parseModList(
        JSON.stringify({
          ...base,
          mods: Array.from({ length: MAX_MOD_LIST_ENTRIES + 1 }, () => ({
            provider: "modrinth",
            projectId: "a",
          })),
        })
      )
    ).toThrow("Invalid mod list");
  });
  it("rejects invalid JSON and strips untrusted download URLs from valid entries", () => {
    expect(() => parseModList("not json")).toThrow("not valid JSON");
    const list = parseModList(
      JSON.stringify({
        ...base,
        mods: [
          {
            provider: "modrinth",
            projectId: "a",
            downloadUrl: "https://untrusted.example/mod.jar",
          },
        ],
      })
    );
    expect(list.mods[0]).toEqual({
      provider: "modrinth",
      projectId: "a",
      dependency: false,
    });
  });
});
