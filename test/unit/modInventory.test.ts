import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, identity } from "../fixtures/mods";
import {
  getModInventory,
  invalidateModInventory,
} from "../../server/utils/mods/inventory";
import type { ModServer } from "../../server/utils/mods/inventory";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  scan: vi.fn(),
  key: vi.fn(),
  modrinth: vi.fn(),
  curseforge: vi.fn(),
  origins: vi.fn(),
}));
vi.mock("../../server/utils/minecraft/jars", () => ({
  listJars: mocks.list,
  invalidateJarList: vi.fn(),
}));
vi.mock("../../server/utils/mods/signatures", () => ({
  scanModSignatures: mocks.scan,
  invalidateModSignatures: vi.fn(),
}));
vi.mock("../../server/utils/secrets", () => ({
  useSecrets: () => ({ get: mocks.key }),
}));
vi.mock("../../server/utils/mods/origins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/utils/mods/origins")>()),
  readModOrigins: mocks.origins,
}));
vi.mock("../../server/utils/mods/modrinth", () => ({
  modrinthSource: { id: "modrinth", identify: mocks.modrinth },
}));
vi.mock("../../server/utils/mods/curseforge", () => ({
  createCurseforgeSource: () => ({
    id: "curseforge",
    identify: mocks.curseforge,
  }),
}));
const server = {
  id: "server",
  running: false,
  config: { type: "FABRIC", MODRINTH_PROJECTS: "a:beta" },
} as ModServer;
beforeEach(() => {
  vi.stubGlobal("createError", apiError);
  invalidateModInventory("server");
  mocks.list.mockResolvedValue([
    { name: "a.jar", size: 3, modifiedAt: "2026-10-28T00:00:00.000Z" },
  ]);
  mocks.scan.mockResolvedValue([
    { filename: "a.jar", sha1: "a".repeat(40), fingerprint: 123 },
  ]);
  mocks.key.mockResolvedValue("test-key");
  mocks.origins.mockResolvedValue({});
  mocks.modrinth.mockResolvedValue({ "a.jar": identity("a") });
  mocks.curseforge.mockResolvedValue({
    "a.jar": identity("123", "curseforge"),
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
describe("provider-neutral mod inventory", () => {
  it("retains both identities, filesystem timestamps and managed integration status", async () => {
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]).toMatchObject({
      modifiedAt: "2026-10-28T00:00:00.000Z",
      managed: true,
      source: "unknown",
    });
    expect(
      inventory.mods[0]?.identities.map((identity) => identity.provider)
    ).toEqual(["modrinth", "curseforge"]);
  });
  it("keeps a manual upload's source even when both providers recognize the jar", async () => {
    mocks.origins.mockResolvedValue({
      "a.jar": { source: "manual", sha1: "a".repeat(40) },
    });
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]?.source).toBe("manual");
    expect(inventory.mods[0]?.identities).toHaveLength(2);
  });
  it("refreshes dependent lists from current files even when identification is cached", async () => {
    mocks.list.mockResolvedValue([
      { name: "a.jar", size: 3, modifiedAt: null },
      { name: "b.jar", size: 3, modifiedAt: null },
    ]);
    mocks.scan.mockResolvedValue([
      { filename: "a.jar", sha1: "a".repeat(40), fingerprint: 1 },
      { filename: "b.jar", sha1: "b".repeat(40), fingerprint: 2 },
    ]);
    mocks.modrinth.mockResolvedValue({
      "a.jar": identity("a"),
      "b.jar": identity("b"),
    });
    mocks.origins.mockResolvedValue({
      "a.jar": {
        source: "modrinth",
        sha1: "a".repeat(40),
        dependencies: [{ provider: "modrinth", projectId: "b" }],
      },
      "b.jar": { source: "manual", sha1: "b".repeat(40) },
    });
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[1]).toMatchObject({
      source: "manual",
      dependency: true,
      requiredBy: [{ filename: "a.jar", name: "Mod a" }],
    });
    mocks.origins.mockResolvedValue({});
    const refreshed = await getModInventory("server", server);
    expect(refreshed.inventory.mods[1]).toMatchObject({
      dependency: false,
      requiredBy: [],
    });
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
  });
  it("shows a recorded CurseForge source independently of Modrinth recognition", async () => {
    mocks.origins.mockResolvedValue({
      "a.jar": { source: "curseforge", sha1: "a".repeat(40) },
    });
    mocks.curseforge.mockRejectedValue(new Error("provider down"));
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]?.source).toBe("curseforge");
    expect(
      inventory.mods[0]?.identities.map((identity) => identity.provider)
    ).toEqual(["modrinth"]);
  });
  it("discards recorded origins when a file's contents no longer match", async () => {
    mocks.origins.mockResolvedValue({
      "a.jar": { source: "modrinth", sha1: "b".repeat(40) },
    });
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]?.source).toBe("unknown");
  });
  it("keeps the list usable when recorded sources cannot be read", async () => {
    mocks.origins.mockRejectedValue(new Error("archive unavailable"));
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]?.source).toBe("unknown");
    expect(inventory.warnings).toContain(
      "Could not read mod tracking records. Installation sources and dependency relationships may be unavailable."
    );
  });
  it("keeps the local list usable when a provider is down", async () => {
    mocks.modrinth.mockRejectedValue(new Error("unavailable"));
    const { inventory } = await getModInventory("server", server);
    expect(inventory.mods[0]?.filename).toBe("a.jar");
    expect(inventory.mods[0]?.identities).toEqual([
      identity("123", "curseforge"),
    ]);
    expect(inventory.warnings).toHaveLength(1);
  });
  it("requires successful identification on the install source for reliable duplicate checks", async () => {
    mocks.modrinth.mockRejectedValue(new Error("unavailable"));
    await expect(
      getModInventory("server", server, {
        fresh: true,
        strictProvider: "modrinth",
      })
    ).rejects.toThrow("unavailable");
  });
  it("disables CurseForge without a key and supplies configuration guidance", async () => {
    mocks.key.mockResolvedValue(undefined);
    const { inventory } = await getModInventory("server", server);
    expect(mocks.curseforge).not.toHaveBeenCalled();
    expect(
      inventory.providers.find((provider) => provider.id === "curseforge")
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("Admin"),
    });
  });
  it("caches unchanged files, rescans modified files and honors forced refresh", async () => {
    await getModInventory("server", server);
    await getModInventory("server", server);
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
    mocks.list.mockResolvedValue([
      { name: "a.jar", size: 4, modifiedAt: "2026-10-29T00:00:00.000Z" },
    ]);
    await getModInventory("server", server);
    await getModInventory("server", server, { fresh: true });
    expect(mocks.modrinth).toHaveBeenCalledTimes(2);
    expect(mocks.scan).toHaveBeenLastCalledWith(
      "server",
      "mods",
      expect.objectContaining({ fresh: true })
    );
  });
  it("queries only new signatures after an install, including when duplicate checks request strict identification", async () => {
    await getModInventory("server", server);
    mocks.list.mockResolvedValue([
      { name: "a.jar", size: 3, modifiedAt: "2026-10-28T00:00:00.000Z" },
      { name: "b.jar", size: 3, modifiedAt: "2026-10-28T00:00:00.000Z" },
    ]);
    const added = { filename: "b.jar", sha1: "b".repeat(40), fingerprint: 456 };
    mocks.scan.mockResolvedValue([
      { filename: "a.jar", sha1: "a".repeat(40), fingerprint: 123 },
      added,
    ]);
    mocks.modrinth.mockResolvedValue({ "b.jar": identity("b") });
    const { inventory } = await getModInventory("server", server, {
      strictProvider: "modrinth",
    });
    expect(mocks.modrinth).toHaveBeenLastCalledWith([added]);
    expect(mocks.curseforge).toHaveBeenLastCalledWith([added]);
    expect(inventory.mods[0]?.identities).toHaveLength(2);
    expect(inventory.mods[1]?.identities).toHaveLength(1);
    expect(mocks.list).toHaveBeenLastCalledWith("server", "mods", {
      fresh: true,
    });
  });
  it("does not reuse CurseForge identification after the API key changes", async () => {
    await getModInventory("server", server);
    mocks.key.mockResolvedValue("replacement-key");
    await getModInventory("server", server);
    expect(mocks.curseforge).toHaveBeenCalledTimes(2);
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
  });
});
