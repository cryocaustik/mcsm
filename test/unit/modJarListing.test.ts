import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listJars,
  invalidateJarList,
  writeJars,
  readJar,
} from "../../server/utils/minecraft/jars";

const listing = (
  name = "a.jar",
  size = 3,
  mtime = "1793232000.123456789",
  ctime = "1793232001.987654321"
) =>
  Buffer.from(
    [String(size), mtime, ctime, "42", name, "", "MCSM-JARS-END", ""].join("\0")
  ).toString("base64");
const run = vi.fn();
beforeEach(() => {
  invalidateJarList("server", "mods");
  vi.stubGlobal("runInVolume", run);
  run.mockResolvedValue(listing());
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("metadata-only jar listing", () => {
  it("returns sizes, modification dates and precise revision tokens without transferring jar contents", async () => {
    const files = await listJars("server", "mods");
    expect(files).toEqual([
      {
        name: "a.jar",
        size: 3,
        modifiedAt: "2026-10-29T00:00:00.123Z",
        revision: "1793232000.123456789:1793232001.987654321:42",
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toContain(
      "find /data/mods -mindepth 1 -maxdepth 1 -type f"
    );
  });
  it("coalesces simultaneous listings and expires its short metadata cache", async () => {
    vi.useFakeTimers();
    await Promise.all([listJars("server", "mods"), listJars("server", "mods")]);
    await listJars("server", "mods");
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    await listJars("server", "mods");
    expect(run).toHaveBeenCalledTimes(2);
    await listJars("server", "mods", { fresh: true });
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("handles spaces, tabs and line breaks in filenames", async () => {
    run.mockResolvedValue(listing("my mod\twith\nspaces.jar"));
    expect((await listJars("server", "mods"))[0]?.name).toBe(
      "my mod\twith\nspaces.jar"
    );
  });
  it("treats a missing folder as empty but propagates listing failures", async () => {
    run.mockResolvedValueOnce(
      Buffer.from("\0MCSM-JARS-END\0").toString("base64")
    );
    expect(await listJars("server", "mods")).toEqual([]);
    run.mockResolvedValueOnce("find: Permission denied");
    await expect(listJars("server", "mods", { fresh: true })).rejects.toThrow(
      "Failed to list"
    );
    run.mockResolvedValueOnce(listing());
    expect(await listJars("server", "mods")).toHaveLength(1);
  });
  it("does not allow directory names to be interpolated as shell commands", async () => {
    await expect(
      listJars("server", "mods; touch /tmp/unwanted")
    ).rejects.toThrow("Invalid jar directory");
    expect(run).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "invalidates metadata after a jar write, including a failed/partial write (%s)",
    async (fail) => {
      await listJars("server", "mods");
      const putArchive = vi.fn(async (stream: NodeJS.ReadableStream) => {
        stream.resume();
        if (fail) throw new Error("write failed");
      });
      vi.stubGlobal("useDocker", () => ({
        docker: { getContainer: () => ({ putArchive }) },
      }));
      vi.stubGlobal("containerOwner", async () => ({ uid: 1000, gid: 1000 }));
      const writing = writeJars(
        "server",
        "mods",
        [{ name: "new.jar", data: Buffer.from("abc") }],
        "manual"
      );
      if (fail) await expect(writing).rejects.toThrow("write failed");
      else await writing;
      run.mockResolvedValueOnce(listing("new.jar"));
      expect((await listJars("server", "mods"))[0]?.name).toBe("new.jar");
      expect(run).toHaveBeenCalledTimes(2);
    }
  );
});

describe("bounded signature file reads", () => {
  it("rejects a file that grows beyond the scan limit without buffering the whole file", async () => {
    const tar = pack();
    tar.entry({ name: "a.jar" }, Buffer.alloc(10));
    tar.finalize();
    vi.stubGlobal("useDocker", () => ({
      docker: { getContainer: () => ({ getArchive: async () => tar }) },
    }));
    await expect(
      readJar("server", "mods", "a.jar", { maxBytes: 3 })
    ).rejects.toThrow("size limit");
  });
});
