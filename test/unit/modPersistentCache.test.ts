import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  scanModSignatures,
  invalidateModSignatures,
} from "../../server/utils/mods/signatures";
import { identifyModFiles } from "../../server/utils/mods/identification";
import { rememberInstalledJars } from "../../server/utils/mods/signature-cache";
import { populateInstallIdentities } from "../../server/utils/mods/install";
import {
  modOriginFile,
  type ModOriginRecord,
} from "../../server/utils/mods/origins";
import {
  getModInventory,
  invalidateModInventory,
  type ModServer,
} from "../../server/utils/mods/inventory";
import type { ModSource } from "../../server/utils/mods/types";
import type { JarInfo, JarFile } from "../../server/utils/minecraft/jars";
import { identity, version } from "../fixtures/mods";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  origins: vi.fn(),
  mr: vi.fn(),
  cf: vi.fn(),
  key: vi.fn(),
}));
vi.mock("../../server/utils/minecraft/jars", () => ({
  listJars: mocks.list,
  readJar: mocks.read,
  invalidateJarList: vi.fn(),
}));
vi.mock("../../server/utils/mods/origins", async (original) => ({
  ...(await original<typeof import("../../server/utils/mods/origins")>()),
  readModOrigins: mocks.origins,
}));
vi.mock("../../server/utils/mods/modrinth", () => ({
  modrinthSource: { id: "modrinth", identify: mocks.mr },
}));
vi.mock("../../server/utils/mods/curseforge", () => ({
  createCurseforgeSource: () => ({ id: "curseforge", identify: mocks.cf }),
}));
vi.mock("../../server/utils/secrets", () => ({
  useSecrets: () => ({ get: mocks.key }),
}));

const disk = new Map<string, unknown>();
const storage = {
  getItem: vi.fn(async (key: string) => structuredClone(disk.get(key) ?? null)),
  setItem: vi.fn(async (key: string, value: unknown) => {
    disk.set(key, structuredClone(value));
  }),
};
const data = Buffer.from("abc");
const file: JarInfo = {
  name: "a.jar",
  size: data.length,
  modifiedAt: "2026-11-04T00:00:00Z",
  revision: "mtime:ctime:inode",
};
const server = {
  id: "persistent",
  running: false,
  config: { type: "FABRIC" },
} as ModServer;
const source: ModSource = {
  id: "modrinth",
  identify: mocks.mr,
  resolve: vi.fn(),
  search: vi.fn(),
};
const lookup = async (fresh = false) =>
  identifyModFiles(
    "persistent:mods:modrinth:",
    source,
    await scanModSignatures(server.id, "mods", { fresh }),
    fresh
  );

beforeEach(() => {
  disk.clear();
  storage.getItem.mockImplementation(async (key) =>
    structuredClone(disk.get(key) ?? null)
  );
  storage.setItem.mockImplementation(async (key, value) => {
    disk.set(key, structuredClone(value));
  });
  invalidateModInventory(server.id);
  vi.stubGlobal("useStorage", () => storage);
  mocks.list.mockResolvedValue([file]);
  mocks.read.mockResolvedValue(data);
  mocks.origins.mockResolvedValue({});
  mocks.key.mockResolvedValue("test-key");
  mocks.mr.mockImplementation(async (files) =>
    Object.fromEntries(
      files.map((file: { filename: string }) => [file.filename, identity("a")])
    )
  );
  mocks.cf.mockResolvedValue({});
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("persistent installed mod metadata", () => {
  it("restores signatures, names, links, versions and icons after all in-memory caches are cleared", async () => {
    const matched = {
      ...identity("a"),
      iconUrl: "https://example.com/icon.png",
    };
    mocks.mr.mockResolvedValue({ "a.jar": matched });
    const first = await lookup();
    expect(disk.size).toBe(2);
    invalidateModInventory(server.id);
    mocks.read.mockClear();
    mocks.mr.mockClear();
    expect(await lookup()).toEqual(first);
    expect((await lookup())["a.jar"]).toEqual(matched);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.mr).not.toHaveBeenCalled();
  });

  it("persists negative matches, so private jars do not get identified again after a restart", async () => {
    mocks.mr.mockResolvedValue({});
    await lookup();
    invalidateModInventory(server.id);
    expect(await lookup()).toEqual({});
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.mr).toHaveBeenCalledTimes(1);
  });

  it("reuses unchanged signatures after a day and returns stale identities without waiting for an unavailable provider", async () => {
    vi.useFakeTimers();
    const first = await lookup();
    invalidateModInventory(server.id);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    let reject!: (error: Error) => void;
    mocks.mr.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    expect(await lookup()).toEqual(first);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.mr).toHaveBeenCalledTimes(2);
    reject(new Error("provider unavailable"));
    await vi.waitFor(() => expect(mocks.mr).toHaveBeenCalledTimes(2));
    expect(await lookup()).toEqual(first);
  });

  it("rehashes a same-size external replacement after restart and does not inherit its old identity", async () => {
    await lookup();
    invalidateModInventory(server.id);
    mocks.list.mockResolvedValue([
      { ...file, revision: "same-mtime:new-ctime:new-inode" },
    ]);
    mocks.read.mockResolvedValue(Buffer.from("xyz"));
    mocks.mr.mockResolvedValue({ "a.jar": identity("replacement") });
    expect((await lookup())["a.jar"]?.projectId).toBe("replacement");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.mr.mock.calls[1]?.[0][0].sha1).toBe(
      createHash("sha1").update("xyz").digest("hex")
    );
  });

  it("an explicit refresh bypasses both persistent caches and reports provider failures", async () => {
    await lookup();
    invalidateModInventory(server.id);
    mocks.mr.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(lookup(true)).rejects.toThrow("provider unavailable");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.mr).toHaveBeenCalledTimes(2);
    expect((await lookup())["a.jar"]?.projectId).toBe("a");
  });

  it("prunes removed signatures from disk so a reintroduced file must be verified", async () => {
    await lookup();
    mocks.list.mockResolvedValue([]);
    await scanModSignatures(server.id, "mods");
    invalidateModSignatures(server.id);
    mocks.list.mockResolvedValue([file]);
    await scanModSignatures(server.id, "mods");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("does not trust persisted hashes without a filesystem revision", async () => {
    mocks.list.mockResolvedValue([{ ...file, revision: undefined }]);
    await lookup();
    await lookup();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("falls back to discovery when persisted data is corrupt or storage is unavailable", async () => {
    await lookup();
    for (const key of disk.keys())
      disk.set(key, {
        version: 1,
        entries: { "a.jar": { revision: "bad", signature: null } },
      });
    invalidateModInventory(server.id);
    await lookup();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    storage.getItem.mockRejectedValueOnce(new Error("storage unavailable"));
    storage.setItem.mockRejectedValueOnce(new Error("storage read-only"));
    invalidateModInventory(server.id);
    await expect(lookup()).resolves.toHaveProperty("a.jar");
  });

  it("stores known identities at installation and displays them without hashing or waiting for cross-provider discovery", async () => {
    const jar: JarFile = {
      name: file.name,
      data,
      metadata: { project: { provider: "modrinth", projectId: "a" } },
    };
    const projects = vi.fn(async () => [identity("a")]);
    await populateInstallIdentities([jar], [version("a")], {
      ...source,
      getProjects: projects,
    });
    const saved = JSON.parse(
      modOriginFile("mods", jar, "modrinth").data.toString()
    ) as ModOriginRecord;
    expect(saved.identity).toEqual(identity("a"));
    mocks.origins.mockResolvedValue({ [file.name]: saved });
    await rememberInstalledJars(server.id, "mods", [jar], [file]);
    invalidateModInventory(server.id);
    let resolve!: (value: object) => void;
    mocks.cf.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const { inventory } = await getModInventory(server.id, server);
    expect(inventory.refreshing).toBe(true);
    expect(inventory.mods[0]?.identities).toEqual([identity("a")]);
    expect(inventory.mods[0]?.source).toBe("modrinth");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.mr).not.toHaveBeenCalled();
    expect(mocks.cf).toHaveBeenCalledTimes(1);
    resolve({ "a.jar": identity("123", "curseforge") });
    await vi.waitFor(async () =>
      expect(
        (await getModInventory(server.id, server)).inventory.mods[0]?.identities
      ).toHaveLength(2)
    );
    expect(
      (await getModInventory(server.id, server)).inventory.refreshing
    ).toBe(false);
  });

  it("shows the installed provider's saved identity even when that provider is no longer configured", async () => {
    const matched = identity("123", "curseforge");
    mocks.key.mockResolvedValue(undefined);
    mocks.origins.mockResolvedValue({
      "a.jar": {
        sha1: createHash("sha1").update(data).digest("hex"),
        source: "curseforge",
        identity: matched,
      },
    });
    mocks.mr.mockResolvedValue({});
    expect(
      (await getModInventory(server.id, server)).inventory.mods[0]?.identities
    ).toEqual([matched]);
    expect(mocks.cf).not.toHaveBeenCalled();
  });

  it("rejects install-time identities whose stored hash no longer matches the file", async () => {
    mocks.origins.mockResolvedValue({
      "a.jar": {
        sha1: "f".repeat(40),
        source: "curseforge",
        identity: identity("old", "curseforge"),
      },
    });
    expect(
      (await getModInventory(server.id, server)).inventory.mods[0]?.identities
    ).toEqual([identity("a")]);
    expect(mocks.mr).toHaveBeenCalledTimes(1);
  });
});
