import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  identifyModFiles,
  invalidateModIdentities,
} from "../../server/utils/mods/identification";
import type {
  ModFileSignature,
  ModSource,
} from "../../server/utils/mods/types";
import { identity } from "../fixtures/mods";

const identify = vi.fn<ModSource["identify"]>();
const source: ModSource = {
  id: "modrinth",
  identify,
  search: vi.fn(),
  resolve: vi.fn(),
};
const signature = (id: number): ModFileSignature => ({
  filename: `${id}.jar`,
  sha1: id.toString(16).padStart(40, "0"),
  fingerprint: id,
});
beforeEach(() => {
  invalidateModIdentities("server");
  identify.mockImplementation(async (files) =>
    Object.fromEntries(
      files.map((file) => [file.filename, identity(file.filename)])
    )
  );
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const lookup = (
  files: ModFileSignature[],
  fresh = false,
  key = "server:modrinth"
) => identifyModFiles(key, source, files, fresh);

describe("incremental provider identification", () => {
  it("looks up only the new file after installing a mod into a collection of 40", async () => {
    const files = Array.from({ length: 40 }, (_, index) => signature(index));
    await lookup(files);
    identify.mockClear();
    const result = await lookup([...files, signature(40)]);
    expect(Object.keys(result)).toHaveLength(41);
    expect(identify).toHaveBeenCalledExactlyOnceWith([signature(40)]);
  });
  it("caches unrecognized files so manual and private jars do not trigger repeated requests", async () => {
    identify.mockResolvedValue({});
    expect(await lookup([signature(1)])).toEqual({});
    expect(await lookup([signature(1)])).toEqual({});
    expect(identify).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent lookups by content and reuses matches after a rename", async () => {
    const file = signature(1);
    const renamed = { ...file, filename: "renamed.jar" };
    const [first, second] = await Promise.all([
      lookup([file]),
      lookup([renamed]),
    ]);
    expect(first[file.filename]).toEqual(second[renamed.filename]);
    expect(identify).toHaveBeenCalledTimes(1);
  });
  it("deduplicates identical files in a batch", async () => {
    const file = signature(1);
    const result = await lookup([file, { ...file, filename: "copy.jar" }]);
    expect(Object.keys(result)).toHaveLength(2);
    expect(identify.mock.calls[0]?.[0]).toHaveLength(1);
  });
  it("retries failed requests and leaves no rejected cached promises", async () => {
    identify.mockRejectedValueOnce(new Error("down"));
    await expect(lookup([signature(1), signature(2)])).rejects.toThrow("down");
    await expect(lookup([signature(1), signature(2)])).resolves.toHaveProperty(
      "1.jar"
    );
    expect(identify).toHaveBeenCalledTimes(2);
  });
  it("expires successful and negative results and honors explicit refresh", async () => {
    vi.useFakeTimers();
    await lookup([signature(1)]);
    await lookup([signature(1)], true);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await lookup([signature(1)]);
    expect(identify).toHaveBeenCalledTimes(3);
  });
  it("isolates providers, server directories and API-key configurations", async () => {
    await lookup([signature(1)], false, "server:mods:modrinth");
    await lookup([signature(1)], false, "server:plugins:modrinth");
    await lookup([signature(1)], false, "server:mods:curseforge:key1");
    await lookup([signature(1)], false, "server:mods:curseforge:key2");
    expect(identify).toHaveBeenCalledTimes(4);
  });
});
