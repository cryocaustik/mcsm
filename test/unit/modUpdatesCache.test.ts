import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModUpdates } from "../../server/utils/mods/updates";
import type { ModServer } from "../../server/utils/mods/inventory";
import { installed } from "../fixtures/mods";

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), check: vi.fn() }));
vi.mock("../../server/utils/mods/inventory", () => ({
  getModInventory: mocks.inventory,
}));
vi.mock("../../server/utils/minecraft/modrinth-api", () => ({
  checkUpdates: mocks.check,
}));
const signature = (id: number) => ({
  filename: `${id}.jar`,
  sha1: id.toString(16).padStart(40, "0"),
  fingerprint: id,
});
const snapshot = (ids: number[]) => ({
  inventory: { mods: ids.map((id) => installed(String(id))) },
  signatures: ids.map(signature),
});
const newer = {
  version_number: "2.0",
  files: [
    { primary: true, filename: "1-new.jar", hashes: { sha1: "f".repeat(40) } },
  ],
};
let counter = 0;
let id: string;
const server = {
  id: "server",
  running: false,
  config: { type: "FABRIC" },
} as ModServer;
const lookup = (fresh = false, loader = "fabric", gameVersion = "1.21.1") =>
  getModUpdates(id, server, loader, gameVersion, fresh);
beforeEach(() => {
  id = `updates-test-${counter++}`;
  mocks.inventory.mockResolvedValue(snapshot([1]));
  mocks.check.mockResolvedValue({ [signature(1).sha1]: newer });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("incremental mod update checks", () => {
  it("uses shared signatures/identities and checks only the new file in a 40-mod collection", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i);
    mocks.inventory.mockResolvedValue(snapshot(ids));
    await lookup();
    mocks.check.mockClear();
    mocks.inventory.mockResolvedValue(snapshot([...ids, 40]));
    await lookup();
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(
      [signature(40).sha1],
      "fabric",
      "1.21.1"
    );
  });
  it("builds update badges from current filenames, identities and managed status", async () => {
    const data = snapshot([1]);
    data.inventory.mods[0]!.managed = true;
    mocks.inventory.mockResolvedValue(data);
    const result = await lookup();
    expect(result.projects).toEqual({
      "1.jar": { projectId: "1", managed: true },
    });
    expect(result.updates).toEqual([
      {
        filename: "1.jar",
        projectId: "1",
        currentSha1: signature(1).sha1,
        latestVersion: "2.0",
        latestFilename: "1-new.jar",
        managed: true,
      },
    ]);
  });
  it("does not retain badges for deleted files", async () => {
    await lookup();
    mocks.inventory.mockResolvedValue(snapshot([]));
    expect((await lookup()).updates).toEqual([]);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it("caches negative update results too", async () => {
    mocks.check.mockResolvedValue({});
    expect((await lookup()).updates).toEqual([]);
    expect((await lookup()).updates).toEqual([]);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it("shares in-flight update requests", async () => {
    const [a, b] = await Promise.all([lookup(), lookup()]);
    expect(a).toEqual(b);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it("invalidates lookups for different loaders and Minecraft versions", async () => {
    await lookup();
    await lookup(false, "forge");
    await lookup(false, "fabric", "1.21.2");
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });
  it("honors explicit refresh and expires update results", async () => {
    vi.useFakeTimers();
    await lookup();
    await lookup(true);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await lookup();
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(mocks.inventory).toHaveBeenCalledWith(id, server, { fresh: true });
  });
  it("retries failures instead of caching them", async () => {
    mocks.check.mockRejectedValueOnce(new Error("provider down"));
    await expect(lookup()).rejects.toThrow("provider down");
    expect((await lookup()).updates).toHaveLength(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });
});
