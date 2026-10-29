import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModInventory,
  invalidateModInventory,
} from "../../server/utils/mods/inventory";
import { getModUpdates } from "../../server/utils/mods/updates";
import { listJars, writeJars } from "../../server/utils/minecraft/jars";
import type { ModServer } from "../../server/utils/mods/inventory";
import { identity } from "../fixtures/mods";

const mocks = vi.hoisted(() => ({
  modrinth: vi.fn(),
  curseforge: vi.fn(),
  updates: vi.fn(),
}));
vi.mock("../../server/utils/secrets", () => ({
  useSecrets: () => ({ get: async () => "test-key" }),
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
vi.mock("../../server/utils/minecraft/modrinth-api", () => ({
  checkUpdates: mocks.updates,
}));

const files = new Map<string, Buffer>();
const metadata = vi.fn();
const archives = vi.fn();
const server = {
  id: "performance-server",
  running: false,
  config: { type: "FABRIC" },
} as ModServer;
const id = server.id;
let updateId = 0;
beforeEach(() => {
  invalidateModInventory(id);
  files.clear();
  for (let i = 0; i < 40; i++)
    files.set(`${i}.jar`, Buffer.from(`mod content ${i}`));
  mocks.modrinth.mockImplementation(async (files) =>
    Object.fromEntries(
      files.map((file: { filename: string }) => [
        file.filename,
        identity(file.filename),
      ])
    )
  );
  mocks.curseforge.mockResolvedValue({});
  mocks.updates.mockResolvedValue({});
  metadata.mockImplementation(async () =>
    Buffer.from(
      [...files]
        .map(([name, data], index) =>
          [
            data.length,
            "1793232000.123456789",
            "1793232001.987654321",
            index,
            name,
            "",
          ].join("\0")
        )
        .join("") + "\0MCSM-JARS-END\0"
    ).toString("base64")
  );
  archives.mockImplementation(async ({ path }: { path: string }) => {
    const filename = path.replace("/data/mods/", "");
    const data = files.get(filename);
    if (!data) throw { statusCode: 404 };
    const tar = pack();
    tar.entry({ name: filename }, data);
    tar.finalize();
    return tar;
  });
  vi.stubGlobal("runInVolume", metadata);
  vi.stubGlobal("containerOwner", async () => ({ uid: 1000, gid: 1000 }));
  vi.stubGlobal("useDocker", () => ({
    docker: {
      getContainer: () => ({
        getArchive: archives,
        putArchive: async (stream: NodeJS.ReadableStream) => {
          stream.resume();
          files.set("new.jar", Buffer.from("new jar content"));
        },
      }),
    },
  }));
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

// Keep the actual listing, signature, fingerprint and identity caches in this
// test, replacing only Docker transport and the external providers.
describe("post-install refresh performance", () => {
  it("shares the complete pipeline across file listing, inventory and update checks", async () => {
    const gameVersion = `test-${updateId++}`;
    const refresh = (fresh = false) =>
      Promise.all([
        listJars(id, "mods"),
        getModInventory(id, server, { fresh }),
        getModUpdates(id, server, "fabric", gameVersion, fresh),
      ]);
    await refresh();
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(
      archives.mock.calls.filter(([request]) =>
        request.path.startsWith("/data/mods/")
      )
    ).toHaveLength(40);
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
    expect(mocks.curseforge).toHaveBeenCalledTimes(1);
    expect(mocks.updates).toHaveBeenCalledTimes(1);
    archives.mockClear();
    mocks.modrinth.mockClear();
    mocks.curseforge.mockClear();
    mocks.updates.mockClear();
    await writeJars(
      id,
      "mods",
      [{ name: "new.jar", data: Buffer.from("new jar content") }],
      "modrinth"
    );
    const [, result] = await refresh();
    expect(result.inventory.mods).toHaveLength(41);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(
      archives.mock.calls.filter(([request]) =>
        request.path.startsWith("/data/mods/")
      )
    ).toEqual([[{ path: "/data/mods/new.jar" }]]);
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
    expect(
      mocks.modrinth.mock.calls[0]?.[0].map(
        (file: { filename: string }) => file.filename
      )
    ).toEqual(["new.jar"]);
    expect(mocks.curseforge).toHaveBeenCalledTimes(1);
    expect(mocks.updates).toHaveBeenCalledTimes(1);
    expect(mocks.updates.mock.calls[0]?.[0]).toHaveLength(1);
    archives.mockClear();
    mocks.modrinth.mockClear();
    await getModInventory(id, server, { strictProvider: "modrinth" });
    expect(metadata).toHaveBeenCalledTimes(3);
    expect(
      archives.mock.calls.filter(([request]) =>
        request.path.startsWith("/data/mods/")
      )
    ).toHaveLength(0);
    expect(mocks.modrinth).not.toHaveBeenCalled();
    await refresh(true);
    expect(
      archives.mock.calls.filter(([request]) =>
        request.path.startsWith("/data/mods/")
      )
    ).toHaveLength(41);
    expect(mocks.modrinth).toHaveBeenCalledTimes(1);
  });
});
