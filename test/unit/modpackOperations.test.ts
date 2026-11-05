import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { H3Event } from "h3";
import type { ServerConfig } from "../../server/schema/server.schema";
import type { InstalledPack, PackOperation } from "../../shared/types/modpacks";
import { apiError } from "../fixtures/mods";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  status: vi.fn(),
  begin: vi.fn(),
  save: vi.fn(),
  catalog: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  spec: vi.fn(),
  recreate: vi.fn(),
  inspect: vi.fn(),
  stop: vi.fn(),
  image: vi.fn(),
  loader: vi.fn(),
  find: vi.fn(),
  server: vi.fn(),
  provision: vi.fn(),
  rcon: vi.fn(),
}));
vi.mock("../../server/utils/modpacks/state", () => ({
  recordPackOperation: mocks.status,
  findPackOperation: mocks.find,
  beginPackOperation: mocks.begin,
  savePackOperation: mocks.save,
}));
vi.mock("../../server/utils/modpacks/installed", async (original) => ({
  ...(await original<typeof import("../../server/utils/modpacks/installed")>()),
  readInstalledPack: mocks.read,
}));
vi.mock("../../server/utils/modpacks/catalog", async (original) => ({
  ...(await original<typeof import("../../server/utils/modpacks/catalog")>()),
  getPackCatalog: mocks.catalog,
  readCachedPackCatalog: mocks.catalog,
}));
vi.mock("../../server/utils/rcon", () => ({ withRcon: mocks.rcon }));
vi.mock("../../server/utils/backups", () => ({
  createBackup: mocks.backup,
  restoreBackup: mocks.restore,
}));
vi.mock("../../server/utils/serverSpec", () => ({
  buildServerSpec: mocks.spec,
  recreateServer: mocks.recreate,
}));
vi.mock("../../server/utils/minecraft/locations", () => ({
  invalidateLoaderCache: mocks.loader,
}));
import { assertPackFilesMutable } from "../../server/utils/modpacks/guard";
import {
  changeModpack,
  getModpackStatus,
} from "../../server/utils/modpacks/operations";

const config = {
  type: "AUTO_CURSEFORGE",
  CF_SLUG: "pack",
  CF_FILE_ID: "10",
  MODPACK_UPDATE_MODE: "pinned",
} as ServerConfig;
const installed: InstalledPack = {
  platform: "curseforge",
  projectId: "42",
  slug: "pack",
  name: "Pack",
  versionId: "10",
  versionName: "1.0",
  minecraft: "1.20.1",
  loader: "forge",
  loaderVersion: "47.0.0",
  files: ["mods/base.jar"],
  hashes: {},
  receipt: true,
};
const version = (id: string, date: string) => ({
  id,
  name: id === "10" ? "1.0" : "2.0",
  releasedAt: date,
  channel: "release",
  minecraft: ["1.20.1"],
});
let row:
  | {
      previousConfig: ServerConfig;
      operation: PackOperation & { volumeSource?: string };
    }
  | undefined;
let work: Promise<unknown>[];
const event = () =>
  ({
    waitUntil: (pending: Promise<unknown>) => {
      work.push(pending);
    },
  }) as unknown as H3Event;
const server = { id: "server", volume: "pack-volume", config, running: true };
const snapshots: PackOperation[] = [];
beforeEach(() => {
  row = undefined;
  work = [];
  snapshots.length = 0;
  vi.stubGlobal("createError", apiError);
  vi.stubGlobal("useDocker", () => ({
    getServer: mocks.server,
    provisionServer: mocks.provision,
    ensureImage: mocks.image,
    stopServer: mocks.stop,
    docker: { getContainer: () => ({ inspect: mocks.inspect }) },
  }));
  mocks.server.mockResolvedValue(server);
  mocks.status.mockImplementation(async () => row);
  mocks.find.mockImplementation(async () =>
    row ? { ...row, volume: "pack-volume", serverId: "server" } : undefined
  );
  mocks.provision.mockImplementation(async () => {
    mocks.server.mockResolvedValue(server);
    return { id: "server" };
  });
  mocks.begin.mockImplementation(
    async (_volume, _id, previousConfig, operation) => {
      row = structuredClone({ previousConfig, operation });
      snapshots.push(structuredClone(operation));
    }
  );
  mocks.save.mockImplementation(async (_volume, operation) => {
    row!.operation = structuredClone(operation);
    snapshots.push(structuredClone(operation));
  });
  mocks.read.mockResolvedValue(installed);
  mocks.inspect.mockResolvedValue({
    State: { Status: "running", Health: { Status: "healthy" } },
  });
  mocks.catalog.mockResolvedValue({
    platform: "curseforge",
    id: "42",
    slug: "pack",
    name: "Pack",
    iconUrl: null,
    url: "https://example.com/pack",
    versions: [version("10", "2026-01-01"), version("20", "2026-02-01")],
  });
  mocks.spec.mockResolvedValue({ image: "itzg/minecraft-server" });
  mocks.image.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.backup.mockResolvedValue({ id: 7 });
  mocks.restore.mockResolvedValue(undefined);
  mocks.recreate.mockResolvedValue({ id: "server" });
});
afterEach(async () => {
  await Promise.allSettled(work);
  await new Promise((done) => setTimeout(done, 0));
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("container-delegated modpack version lifecycle", () => {
  it("validates before stopping, backs up before recreating, and records installation separately from readiness", async () => {
    const result = await changeModpack(event(), "server", {
      versionId: "20",
      mode: "pinned",
    });
    expect(result.accepted).toBe(true);
    await Promise.all(work);
    expect(mocks.backup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recreate.mock.invocationCallOrder[0]!
    );
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.backup.mock.invocationCallOrder[0]!
    );
    expect(mocks.image.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stop.mock.invocationCallOrder[0]!
    );
    expect(mocks.recreate.mock.calls[0]?.[2]).toMatchObject({
      CF_FILE_ID: "20",
      MODPACK_UPDATE_MODE: "pinned",
    });
    expect(row?.previousConfig.CF_FILE_ID).toBe("10");
    expect(row?.operation).toMatchObject({
      state: "installing",
      target: "20",
      backupId: 7,
    });
    expect(snapshots.map((state) => state.state)).toEqual([
      "backing-up",
      "backing-up",
      "recreating",
      "installing",
    ]);
    // Docker running alone is insufficient, even with the target manifest.
    mocks.read.mockResolvedValue({
      ...installed,
      versionId: "20",
      versionName: "2.0",
    });
    mocks.inspect.mockResolvedValue({
      State: { Status: "running", Health: { Status: "starting" } },
    });
    expect((await getModpackStatus(event(), "server"))?.operation?.state).toBe(
      "installing"
    );
    mocks.inspect.mockResolvedValue({
      State: { Status: "running", Health: { Status: "healthy" } },
    });
    expect((await getModpackStatus(event(), "server"))?.operation?.state).toBe(
      "complete"
    );
  });
  it("preserves a recovery status when a failed recreation leaves no container", async () => {
    row = {
      previousConfig: config,
      operation: {
        state: "recreating",
        target: "20",
        startedAt: 1,
        backupId: 7,
        volumeSource: "/original/world",
      },
    };
    mocks.server.mockRejectedValue({ statusCode: 404 });
    const status = await getModpackStatus(event(), "server");
    expect(status).toMatchObject({
      containerAvailable: false,
      ready: false,
      operation: { state: "failed", backupId: 7 },
    });
    expect(status?.operation).not.toHaveProperty("volumeSource");
    expect(status).not.toHaveProperty("previousConfig");
  });
  it("recovers a missing container in a stopped state before restoring its original mounted volume", async () => {
    row = {
      previousConfig: config,
      operation: {
        state: "failed",
        target: "20",
        startedAt: 1,
        backupId: 7,
        volumeSource: "/original/world",
      },
    };
    mocks.server.mockRejectedValue({ statusCode: 404 });
    await changeModpack(event(), "server", { rollback: true });
    await Promise.all(work);
    expect(mocks.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "server",
        volume: "pack-volume",
        volumeSource: "/original/world",
        start: false,
      })
    );
    expect(mocks.provision.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restore.mock.invocationCallOrder[0]!
    );
    expect(mocks.restore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recreate.mock.invocationCallOrder[0]!
    );
  });
  it("allows rollback even if the failed installer left malformed metadata", async () => {
    row = {
      previousConfig: config,
      operation: { state: "failed", target: "20", startedAt: 1, backupId: 7 },
    };
    mocks.read.mockRejectedValue(new Error("partial json"));
    await changeModpack(event(), "server", { rollback: true });
    await Promise.all(work);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
  });
  it("does not accept a healthy container running the wrong requested version", async () => {
    row = {
      previousConfig: config,
      operation: {
        state: "installing",
        target: "20",
        startedAt: 1,
        backupId: 7,
      },
    };
    expect((await getModpackStatus(event(), "server"))?.operation?.state).toBe(
      "failed"
    );
  });
  it("uses an RCON readiness probe for images without a Docker healthcheck", async () => {
    mocks.inspect.mockResolvedValue({ State: { Status: "running" } });
    mocks.rcon.mockResolvedValue(true);
    expect((await getModpackStatus(event(), "server"))?.ready).toBe(true);
    mocks.rcon.mockRejectedValue(new Error("not ready"));
    expect((await getModpackStatus(event(), "server"))?.ready).toBe(false);
  });
  it("does not mistake an interrupted policy change for completion when the old container is healthy", async () => {
    row = {
      previousConfig: config,
      operation: { state: "backing-up", startedAt: Date.now(), target: "10" },
    };
    expect((await getModpackStatus(event(), "server"))?.operation?.state).toBe(
      "failed"
    );
  });
  it("blocks individual custom mod writes during a pack change", async () => {
    row = {
      previousConfig: config,
      operation: { state: "installing", startedAt: Date.now(), target: "20" },
    };
    await expect(
      assertPackFilesMutable("server", server, ["extra.jar"])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("refuses unknown version IDs before any server or backup mutation", async () => {
    await expect(
      changeModpack(event(), "server", { versionId: "wrong" })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("does not change the container when the backup fails", async () => {
    mocks.backup.mockRejectedValue(new Error("backup storage unavailable"));
    await changeModpack(event(), "server", { versionId: "20" });
    await Promise.all(work);
    expect(mocks.recreate).not.toHaveBeenCalled();
    expect(row?.operation).toMatchObject({
      state: "failed",
      error: "backup storage unavailable",
    });
    expect(row?.previousConfig.CF_FILE_ID).toBe("10");
  });
  it("retains the recovery backup and config when container recreation fails", async () => {
    mocks.recreate.mockRejectedValue(new Error("container failed"));
    await changeModpack(event(), "server", { versionId: "20" });
    await Promise.all(work);
    expect(row?.operation).toMatchObject({ state: "failed", backupId: 7 });
    expect(row?.previousConfig.CF_FILE_ID).toBe("10");
  });
  it("blocks simultaneous update requests for the same volume", async () => {
    let finish!: (value: { id: number }) => void;
    mocks.backup.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await changeModpack(event(), "server", { versionId: "20" });
    await expect(
      changeModpack(event(), "server", { versionId: "20" })
    ).rejects.toMatchObject({ statusCode: 409 });
    finish({ id: 7 });
    await Promise.all(work);
    expect(mocks.recreate).toHaveBeenCalledTimes(1);
  });
  it("restores the full backup before restoring the previous pinned container configuration", async () => {
    row = {
      previousConfig: { ...config, CF_FILE_ID: "9" },
      operation: { state: "failed", startedAt: 1, target: "20", backupId: 7 },
    };
    await changeModpack(event(), "server", { rollback: true });
    await Promise.all(work);
    expect(mocks.restore).toHaveBeenCalledWith(expect.anything(), "server", 7);
    expect(mocks.restore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recreate.mock.invocationCallOrder[0]!
    );
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.recreate.mock.calls[0]?.[2].CF_FILE_ID).toBe("9");
  });
  it("does not mark a failed installer as a successful version change", async () => {
    row = {
      previousConfig: config,
      operation: {
        state: "installing",
        startedAt: 1,
        target: "20",
        backupId: 7,
      },
    };
    mocks.read.mockResolvedValue({
      ...installed,
      versionId: "20",
      receipt: false,
    });
    mocks.inspect.mockResolvedValue({
      State: { Status: "exited", ExitCode: 1 },
    });
    const status = await getModpackStatus(event(), "server");
    expect(status?.ready).toBe(false);
    expect(status?.operation?.state).toBe("failed");
    expect(status?.operation?.backupId).toBe(7);
  });
  it("keeps installed details visible when version discovery is unavailable", async () => {
    mocks.catalog.mockRejectedValue(new Error("provider down"));
    const status = await getModpackStatus(event(), "server");
    expect(status?.installed?.versionId).toBe("10");
    expect(status?.warnings).toHaveLength(1);
    expect(status?.catalog).toBeNull();
  });
  it("uses the container's follow-latest behavior and accepts its actual resolved version", async () => {
    await changeModpack(event(), "server", { mode: "latest" });
    await Promise.all(work);
    expect(mocks.recreate.mock.calls[0]?.[2]).toMatchObject({
      CF_FILE_ID: null,
      MODPACK_UPDATE_MODE: "latest",
    });
    expect(row?.operation.target).toBe("latest");
    mocks.read.mockResolvedValue({ ...installed, versionId: "30" });
    expect((await getModpackStatus(event(), "server"))?.operation?.state).toBe(
      "complete"
    );
  });
});
