import { describe, expect, it } from "vitest";
import { curseforgeFingerprint } from "../../server/utils/mods/fingerprint";
import {
  filterInstalledMods,
  installedModKeys,
  installedModLinkIdentity,
} from "../../shared/utils/mods";
import { identity, installed } from "../fixtures/mods";

describe("CurseForge fingerprint", () => {
  it.each([
    ["", 1540447798],
    ["a", 626045324],
    ["ab", 1692487918],
    ["abc", 1621425345],
    ["abcd", 3376380438],
    ["hello world", 2824650221],
  ])("matches MurmurHash2 seed-1 vector %j", (input, expected) => {
    expect(curseforgeFingerprint(Buffer.from(input))).toBe(expected);
  });
  it("ignores only the four whitespace bytes used by CurseForge", () => {
    expect(curseforgeFingerprint(Buffer.from("a\tb\nc\rd e"))).toBe(
      curseforgeFingerprint(Buffer.from("abcde"))
    );
    expect(curseforgeFingerprint(Buffer.from("a\vb"))).not.toBe(
      curseforgeFingerprint(Buffer.from("ab"))
    );
  });
  it("handles arbitrary binary data and unsigned results", () => {
    expect(
      curseforgeFingerprint(Uint8Array.from({ length: 256 }, (_, i) => i))
    ).toBe(2094645347);
  });
  it("preserves word alignment when whitespace is removed from binary files", () => {
    // Compare the streaming word assembly against known vectors after inserting
    // whitespace in every possible position, including across four-byte words.
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let position = 0; position <= binary.length; position++) {
      const expanded = Buffer.concat([
        binary.subarray(0, position),
        Buffer.from([9, 10, 13, 32]),
        binary.subarray(position),
      ]);
      expect(curseforgeFingerprint(expanded)).toBe(2094645347);
    }
  });
});

describe("installed mod identity", () => {
  const crossListed = {
    ...installed("a"),
    identities: [identity("a"), identity("123", "curseforge")],
  };
  const unknown = { ...installed("custom"), identities: [] };
  const mods = [crossListed, unknown];
  it("links a CurseForge download to CurseForge even when Modrinth is listed first", () => {
    const fromCurseforge = { ...crossListed, source: "curseforge" as const };
    const linked = installedModLinkIdentity(fromCurseforge);
    expect(linked?.websiteUrl).toBe(crossListed.identities[1]!.websiteUrl);
    expect(linked?.provider).toBe("curseforge");
    expect(linked?.name).toBe("Mod 123");
  });
  it("follows a Modrinth acquisition regardless of provider listing order", () => {
    const mod = {
      ...crossListed,
      identities: [...crossListed.identities].reverse(),
    };
    expect(installedModLinkIdentity(mod)?.provider).toBe("modrinth");
  });
  it.each(["manual", "unknown"] as const)(
    "uses a verified listing as the fallback for %s files",
    (source) => {
      expect(
        installedModLinkIdentity({ ...crossListed, source })?.websiteUrl
      ).toBe(crossListed.identities[0]!.websiteUrl);
    }
  );
  it.each(["modrinth", "curseforge"] as const)(
    "leaves the name unlinked when the recorded %s source is unavailable",
    (source) => {
      const available = source === "modrinth" ? "curseforge" : "modrinth";
      expect(
        installedModLinkIdentity({
          ...crossListed,
          source,
          identities: [identity("other", available)],
        })
      ).toBeUndefined();
    }
  );
  it("leaves unidentified files unlinked", () => {
    expect(installedModLinkIdentity(unknown)).toBeUndefined();
  });
  it("qualifies IDs by source and retains both verified identities", () => {
    expect([...installedModKeys(mods)]).toEqual([
      "modrinth:a",
      "curseforge:123",
    ]);
    expect(installedModKeys(mods).has("curseforge:a")).toBe(false);
  });
  it("searches names, filenames and versions with provider filtering", () => {
    expect(filterInstalledMods(mods, "MOD A", "curseforge")).toEqual([
      crossListed,
    ]);
    expect(filterInstalledMods(mods, "custom.jar", "unknown")).toEqual([
      unknown,
    ]);
    expect(filterInstalledMods(mods, "1.0", "all")).toEqual([crossListed]);
    expect(filterInstalledMods(mods, " custom ", "modrinth")).toEqual([]);
  });
  it("filters acquisition source independently of verified provider listings", () => {
    const manual = { ...crossListed, source: "manual" as const };
    const fromCurseforge = { ...crossListed, source: "curseforge" as const };
    const untracked = { ...crossListed, source: "unknown" as const };
    const files = [manual, fromCurseforge, untracked];
    expect(filterInstalledMods(files, "", "modrinth", "manual")).toEqual([
      manual,
    ]);
    expect(filterInstalledMods(files, "", "modrinth", "curseforge")).toEqual([
      fromCurseforge,
    ]);
    expect(filterInstalledMods(files, "", "curseforge", "unknown")).toEqual([
      untracked,
    ]);
    expect(filterInstalledMods(files, "", "unknown", "manual")).toEqual([]);
  });
});
