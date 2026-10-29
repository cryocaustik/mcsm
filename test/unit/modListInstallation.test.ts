import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installServerMod } from "../../server/utils/mods/installation";
import { writeJarOrigin } from "../../server/utils/minecraft/jars";
import type { ModOriginRecord } from "../../server/utils/mods/origins";
import type { H3Event } from "h3";
import { apiError, installed, version } from "../fixtures/mods";

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  resolve: vi.fn(),
  download: vi.fn(),
  origin: vi.fn(),
}));
vi.mock("../../server/utils/mods/inventory", () => ({
  getModInventory: mocks.inventory,
}));
vi.mock("../../server/utils/mods/download", () => ({
  downloadModFile: mocks.download,
}));
vi.mock("../../server/utils/minecraft/jars", () => ({
  writeJarOrigin: mocks.origin,
}));
const write = vi.fn();
const restart = vi.fn();
const activity = vi.fn();
const hash = (id: string) => id.repeat(40);
const body: Record<string, unknown> = {};
const source = { id: "modrinth", resolve: mocks.resolve };
const server = {
  id: "server",
  volume: "volume",
  running: true,
  config: { type: "FABRIC" },
};
const event = {} as H3Event;
function snapshot(ids: string[] = []) {
  return {
    inventory: { mods: ids.map((id) => installed(id)) },
    signatures: ids.map((id) => ({
      filename: `${id}.jar`,
      sha1: hash(id),
      fingerprint: 1,
    })),
    sources: [source],
    origins: {} as Record<string, ModOriginRecord>,
  };
}
beforeEach(() => {
  Object.keys(body).forEach((key) => delete body[key]);
  Object.assign(body, {
    provider: "modrinth",
    project: "a",
    skipInstalled: true,
    restart: false,
  });
  mocks.inventory.mockResolvedValue(snapshot());
  mocks.resolve.mockImplementation(async (id) =>
    version(id, {
      sha1: hash(id),
      dependencies:
        id === "a"
          ? [{ projectId: "b" }]
          : id === "b"
            ? [{ projectId: "c" }]
            : [],
    })
  );
  mocks.download.mockImplementation(async (file) => ({
    name: file.filename,
    data: Buffer.from(file.projectId),
  }));
  vi.stubGlobal("createError", apiError);
  vi.stubGlobal(
    "getValidatedRouterParams",
    async (_event: unknown, parse: (input: unknown) => unknown) =>
      parse({ id: "server" })
  );
  vi.stubGlobal(
    "readValidatedBody",
    async (_event: unknown, parse: (input: unknown) => unknown) => parse(body)
  );
  vi.stubGlobal("useDocker", () => ({
    getServer: async () => server,
    restartServer: restart,
  }));
  vi.stubGlobal("jarsDir", () => "mods");
  vi.stubGlobal("resolveServerLoader", async () => "fabric");
  vi.stubGlobal("serverGameVersion", async () => "1.21.1");
  vi.stubGlobal("writeJars", write);
  vi.stubGlobal("recordActivity", activity);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("import through the shared installation pipeline", () => {
  it("resolves, verifies and installs required dependencies even when only a root is imported", async () => {
    const result = await installServerMod(event);
    expect(
      result.added.map((file) => [file.filename, file.dependency])
    ).toEqual([
      ["a.jar", false],
      ["b.jar", true],
      ["c.jar", true],
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[2][0].metadata.dependencies).toEqual([
      { provider: "modrinth", projectId: "b", sha1: hash("b") },
    ]);
    expect(restart).not.toHaveBeenCalled();
  });
  it("rechecks transitive dependencies of retained mods and preserves every existing source", async () => {
    const data = snapshot(["a", "b"]);
    data.inventory.mods[0]!.source = "manual";
    data.inventory.mods[1]!.source = "unknown";
    mocks.inventory.mockResolvedValue(data);
    const result = await installServerMod(event);
    expect(result).toMatchObject({
      alreadyInstalled: true,
      restarted: false,
      added: [{ filename: "c.jar", dependency: true }],
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download.mock.calls[0]?.[0].projectId).toBe("c");
    expect(writeJarOrigin).toHaveBeenCalledTimes(2);
    expect(
      mocks.origin.mock.calls.map(([, record]) => [
        record.filename,
        record.source,
        record.dependencies[0].projectId,
      ])
    ).toEqual([
      ["a.jar", "manual", "b"],
      ["b.jar", "unknown", "c"],
    ]);
    expect(mocks.resolve).toHaveBeenCalledWith("a", "fabric", "1.21.1", "a-v1");
    expect(mocks.resolve).toHaveBeenCalledWith("b", "fabric", "1.21.1", "b-v1");
  });
  it("retains already installed files without downloading or restarting when their dependencies are present", async () => {
    mocks.inventory.mockResolvedValue(snapshot(["a", "b", "c"]));
    body.restart = true;
    const result = await installServerMod(event);
    expect(result).toMatchObject({
      added: [],
      alreadyInstalled: true,
      restarted: false,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
  it("fails before any file is written if a required dependency cannot be resolved", async () => {
    mocks.resolve.mockImplementation(async (id) =>
      id === "a"
        ? version("a", { dependencies: [{ projectId: "missing" }] })
        : null
    );
    await expect(installServerMod(event)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(writeJarOrigin).not.toHaveBeenCalled();
  });
  it("rejects conflicting exported versions without replacing the destination's mod", async () => {
    mocks.inventory.mockResolvedValue(snapshot(["a"]));
    body.versionId = "a-v2";
    await expect(installServerMod(event)).rejects.toThrow("different version");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("passes listed version IDs to the provider and preserves imported dependency tags", async () => {
    body.versionId = "a-v1";
    body.dependency = true;
    const result = await installServerMod(event);
    expect(mocks.resolve).toHaveBeenCalledWith("a", "fabric", "1.21.1", "a-v1");
    expect(result.added[0]?.dependency).toBe(true);
    expect(write.mock.calls[0]?.[2][0].metadata.dependency).toBe(true);
  });
  it("does not turn a retained manual upload into an automatic dependency", async () => {
    const data = snapshot(["a", "b", "c"]);
    data.inventory.mods[0]!.source = "manual";
    mocks.inventory.mockResolvedValue(data);
    body.dependency = true;
    await installServerMod(event);
    expect(mocks.origin.mock.calls[0]?.[1]).toMatchObject({
      filename: "a.jar",
      source: "manual",
      dependency: false,
    });
  });
  it("still rejects duplicate installs from the ordinary browser", async () => {
    body.skipInstalled = false;
    mocks.inventory.mockResolvedValue(snapshot(["a"]));
    await expect(installServerMod(event)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("imports CurseForge projects and their required dependencies through the same resolver", async () => {
    body.provider = "curseforge";
    body.project = "1";
    const data = snapshot();
    data.sources = [{ ...source, id: "curseforge" }];
    mocks.inventory.mockResolvedValue(data);
    mocks.resolve.mockImplementation(async (id) =>
      version(id, {
        provider: "curseforge",
        versionId: id === "1" ? "101" : "102",
        sha1: id.repeat(40),
        dependencies: id === "1" ? [{ projectId: "2" }] : [],
      })
    );
    const result = await installServerMod(event);
    expect(result.added.map((file) => file.filename)).toEqual([
      "1.jar",
      "2.jar",
    ]);
    expect(write.mock.calls[0]?.[3]).toBe("curseforge");
    expect(write.mock.calls[0]?.[2][0].metadata.dependencies[0]).toMatchObject({
      provider: "curseforge",
      projectId: "2",
    });
  });
  it("keeps an identical file acquired from the other provider and records newly checked dependencies", async () => {
    const data = snapshot(["a"]);
    data.inventory.mods[0] = {
      ...installed("a", "curseforge"),
      identities: [
        { ...installed("123", "curseforge").identities[0]!, versionId: "456" },
      ],
    };
    mocks.inventory.mockResolvedValue(data);
    const result = await installServerMod(event);
    expect(result.alreadyInstalled).toBe(true);
    expect(mocks.download.mock.calls.map(([file]) => file.projectId)).toEqual([
      "b",
      "c",
    ]);
    expect(mocks.origin.mock.calls[0]?.[1]).toMatchObject({
      filename: "a.jar",
      source: "curseforge",
      dependencies: [{ provider: "modrinth", projectId: "b" }],
    });
  });
});
