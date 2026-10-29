import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scanModSignatures,
  invalidateModSignatures,
} from "../../server/utils/mods/signatures";
import { curseforgeFingerprint } from "../../server/utils/mods/fingerprint";
import type { JarInfo } from "../../server/utils/minecraft/jars";

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock("../../server/utils/minecraft/jars", () => ({
  listJars: mocks.list,
  readJar: mocks.read,
}));
const jar = (name: string, revision = "1"): JarInfo => ({
  name: `${name}.jar`,
  size: 3,
  modifiedAt: "2026-10-28T00:00:00.000Z",
  revision,
});
beforeEach(() => {
  invalidateModSignatures("server");
  mocks.list.mockResolvedValue([jar("a")]);
  mocks.read.mockResolvedValue(Buffer.from("abc"));
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("incremental installed file signatures", () => {
  it("hashes new files and shares the results between inventory and update requests", async () => {
    const results = await Promise.all([
      scanModSignatures("server", "mods"),
      scanModSignatures("server", "mods"),
    ]);
    expect(results[0]).toEqual([
      {
        filename: "a.jar",
        sha1: createHash("sha1").update("abc").digest("hex"),
        fingerprint: curseforgeFingerprint(Buffer.from("abc")),
      },
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith("server", "mods", "a.jar", {
      maxBytes: 100 * 1024 * 1024,
    });
  });
  it("reads only the newly installed jar in a collection of 40 mods", async () => {
    const files = Array.from({ length: 40 }, (_, index) => jar(String(index)));
    await scanModSignatures("server", "mods", { files });
    mocks.read.mockClear();
    const signatures = await scanModSignatures("server", "mods", {
      files: [...files, jar("new")],
    });
    expect(signatures).toHaveLength(41);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read.mock.calls[0]?.[2]).toBe("new.jar");
  });
  it("detects same-size replacements through ctime/inode revisions", async () => {
    await scanModSignatures("server", "mods");
    mocks.read.mockResolvedValue(Buffer.from("xyz"));
    const signatures = await scanModSignatures("server", "mods", {
      files: [jar("a", "2")],
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(signatures[0]?.sha1).toBe(
      createHash("sha1").update("xyz").digest("hex")
    );
  });
  it("prunes removed files and does not reuse a removed file's cached signature", async () => {
    await scanModSignatures("server", "mods");
    expect(await scanModSignatures("server", "mods", { files: [] })).toEqual(
      []
    );
    await scanModSignatures("server", "mods");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("skips oversized files without transferring their contents", async () => {
    const result = await scanModSignatures("server", "mods", {
      files: [{ ...jar("large"), size: 101 * 1024 * 1024 }],
    });
    expect(result).toEqual([]);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("bounds cold-scan archive concurrency", async () => {
    let active = 0,
      maximum = 0;
    mocks.read.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return Buffer.from("abc");
    });
    await scanModSignatures("server", "mods", {
      files: Array.from({ length: 10 }, (_, index) => jar(String(index))),
    });
    expect(maximum).toBe(4);
  });
  it("explicit refresh and periodic verification recompute unchanged signatures", async () => {
    vi.useFakeTimers();
    await scanModSignatures("server", "mods");
    await scanModSignatures("server", "mods", { fresh: true });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await scanModSignatures("server", "mods");
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });
  it("does not cache failed reads or files that changed size during a scan", async () => {
    mocks.read.mockRejectedValueOnce(new Error("read failed"));
    await expect(scanModSignatures("server", "mods")).rejects.toThrow(
      "read failed"
    );
    mocks.read.mockResolvedValueOnce(Buffer.from("changed length"));
    await expect(scanModSignatures("server", "mods")).rejects.toThrow(
      "changed during identification"
    );
    await expect(scanModSignatures("server", "mods")).resolves.toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });
  it("does not share signatures across servers or directories", async () => {
    await scanModSignatures("server", "mods");
    await scanModSignatures("server", "plugins");
    await scanModSignatures("other", "mods");
    expect(mocks.read).toHaveBeenCalledTimes(3);
    invalidateModSignatures("other");
  });
});
