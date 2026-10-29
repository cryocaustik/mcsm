import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { extract, pack } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteJar,
  writeJars,
  writeJarOrigin,
} from "../../server/utils/minecraft/jars";
import {
  MOD_ORIGINS_DIR,
  modOriginFile,
  modOriginPath,
  readModOrigins,
  recordedModSource,
  type ModOriginRecord,
} from "../../server/utils/mods/origins";

afterEach(() => vi.unstubAllGlobals());
const jar = { name: "example.jar", data: Buffer.from("jar-content") };
function archive(files: { name: string; data: Buffer }[]) {
  const tar = pack();
  for (const file of files) tar.entry({ name: file.name }, file.data);
  tar.finalize();
  return tar;
}
function archiveContents(
  stream: NodeJS.ReadableStream
): Promise<{ name: string; data: Buffer; uid?: number }[]> {
  return new Promise((resolve, reject) => {
    const files: { name: string; data: Buffer; uid?: number }[] = [];
    const tar = extract();
    tar.on("entry", (header, entry, next) => {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk) => chunks.push(chunk as Buffer));
      entry.on("end", () => {
        files.push({
          name: header.name,
          data: Buffer.concat(chunks),
          uid: header.uid,
        });
        next();
      });
    });
    tar.on("finish", () => resolve(files));
    tar.on("error", reject);
    stream.pipe(tar);
  });
}

describe("persisted mod acquisition source", () => {
  it("persists checked dependencies for an existing untracked jar without rewriting it or inventing an origin", async () => {
    const record: ModOriginRecord = {
      version: 1,
      directory: "mods",
      filename: jar.name,
      sha1: createHash("sha1").update(jar.data).digest("hex"),
      source: "unknown",
      project: { provider: "modrinth", projectId: "a" },
      dependencies: [{ provider: "modrinth", projectId: "b" }],
      dependency: false,
    };
    let written: { name: string; data: Buffer; uid?: number }[] = [];
    vi.stubGlobal("useDocker", () => ({
      docker: {
        getContainer: () => ({
          putArchive: async (stream: NodeJS.ReadableStream) => {
            written = await archiveContents(stream);
          },
          getArchive: async () => archive(written),
        }),
      },
    }));
    vi.stubGlobal("containerOwner", async () => ({ uid: 1000, gid: 1000 }));
    await writeJarOrigin("server", record);
    expect(written.map((file) => file.name)).toEqual([
      `${MOD_ORIGINS_DIR}/`,
      modOriginPath("mods", jar.name),
    ]);
    expect(written[1]?.uid).toBe(1000);
    expect((await readModOrigins("server", "mods"))[jar.name]).toEqual(record);
    expect(recordedModSource(record, record.sha1)).toBe("unknown");
  });
  it("round trips dependency links with the jar's hash-bound source record", async () => {
    const metadata = {
      project: { provider: "curseforge" as const, projectId: "123" },
      dependency: true,
      dependencies: [
        {
          provider: "curseforge" as const,
          projectId: "456",
          sha1: "a".repeat(40),
        },
      ],
    };
    const file = modOriginFile("mods", { ...jar, metadata }, "curseforge");
    vi.stubGlobal("useDocker", () => ({
      docker: {
        getContainer: () => ({ getArchive: async () => archive([file]) }),
      },
    }));
    const records = await readModOrigins("server", "mods");
    expect(records[jar.name]).toMatchObject({
      ...metadata,
      source: "curseforge",
    });
  });
  it.each([
    { dependency: "yes" },
    { project: { provider: "invented", projectId: "a" } },
    { dependencies: [{ provider: "modrinth", projectId: "" }] },
    {
      dependencies: [{ provider: "modrinth", projectId: "b", sha1: "invalid" }],
    },
    {
      dependencies: Array.from({ length: 101 }, () => ({
        provider: "modrinth",
        projectId: "b",
      })),
    },
  ])("rejects malformed dependency metadata: %j", async (invalid) => {
    const file = modOriginFile("mods", jar, "modrinth");
    file.data = Buffer.from(
      JSON.stringify({ ...JSON.parse(file.data.toString()), ...invalid })
    );
    vi.stubGlobal("useDocker", () => ({
      docker: {
        getContainer: () => ({ getArchive: async () => archive([file]) }),
      },
    }));
    await expect(readModOrigins("server", "mods")).resolves.toEqual({});
  });
  it.each(["manual", "modrinth", "curseforge"] as const)(
    "writes the jar and its %s source together with the server's ownership",
    async (source) => {
      const putArchive = vi.fn(async (stream) => {
        return archiveContents(stream);
      });
      vi.stubGlobal("useDocker", () => ({
        docker: { getContainer: () => ({ putArchive }) },
      }));
      vi.stubGlobal("containerOwner", async () => ({ uid: 1000, gid: 1000 }));
      await writeJars("server", "mods", [jar], source);
      const files = await putArchive.mock.results[0]!.value;
      expect(
        files.find((file) => file.name === "mods/example.jar")?.data
      ).toEqual(jar.data);
      const metadata = files.find(
        (file) => file.name === modOriginPath("mods", jar.name)
      );
      expect(metadata?.uid).toBe(1000);
      expect(JSON.parse(metadata!.data.toString())).toEqual({
        version: 1,
        directory: "mods",
        filename: jar.name,
        source,
        sha1: createHash("sha1").update(jar.data).digest("hex"),
      });
      expect(putArchive).toHaveBeenCalledTimes(1);
    }
  );
  it("reads persisted metadata using a replacement container and keeps plugin sources separate", async () => {
    const mod = modOriginFile("mods", jar, "manual");
    const plugin = modOriginFile("plugins", jar, "modrinth");
    const getArchive = vi.fn(async () => archive([mod, plugin]));
    vi.stubGlobal("useDocker", () => ({
      docker: { getContainer: () => ({ getArchive }) },
    }));
    const records = await readModOrigins("replacement-container", "mods");
    expect(records[jar.name]?.source).toBe("manual");
    expect(getArchive).toHaveBeenCalledWith({
      path: `/data/${MOD_ORIGINS_DIR}`,
    });
    const pluginRecords = await readModOrigins(
      "replacement-container",
      "plugins"
    );
    expect(pluginRecords[jar.name]?.source).toBe("modrinth");
  });
  it("replaces a provider label with manual when the same bytes are uploaded again", async () => {
    const downloaded = modOriginFile("mods", jar, "curseforge");
    const uploaded = modOriginFile("mods", jar, "manual");
    expect(downloaded.name).toBe(uploaded.name);
    const previous = JSON.parse(downloaded.data.toString()) as ModOriginRecord;
    const current = JSON.parse(uploaded.data.toString()) as ModOriginRecord;
    expect(previous.sha1).toBe(current.sha1);
    expect(recordedModSource(current, previous.sha1)).toBe("manual");
  });
  it("never infers a source for untracked files or changed contents", () => {
    const record = JSON.parse(
      modOriginFile("mods", jar, "curseforge").data.toString()
    ) as ModOriginRecord;
    expect(recordedModSource(undefined, record.sha1)).toBe("unknown");
    expect(recordedModSource(record, "b".repeat(40))).toBe("unknown");
    expect(recordedModSource(record, undefined)).toBe("unknown");
    expect(recordedModSource(record, record.sha1)).toBe("curseforge");
  });
  it("treats missing tracking metadata as unknown", async () => {
    vi.stubGlobal("useDocker", () => ({
      docker: {
        getContainer: () => ({
          getArchive: vi.fn().mockRejectedValue({ statusCode: 404 }),
        }),
      },
    }));
    await expect(readModOrigins("server", "mods")).resolves.toEqual({});
  });
  it("ignores malformed, unsupported, misplaced and oversized records", async () => {
    const file = modOriginFile("mods", jar, "manual");
    const original = JSON.parse(file.data.toString());
    const files = [
      { ...file, data: Buffer.from("not json") },
      {
        ...file,
        data: Buffer.from(JSON.stringify({ ...original, source: "invented" })),
      },
      {
        ...file,
        data: Buffer.from(JSON.stringify({ ...original, version: 2 })),
      },
      { ...file, name: `${MOD_ORIGINS_DIR}/wrong-key.json` },
      {
        ...file,
        data: Buffer.from(JSON.stringify(original) + " ".repeat(32 * 1024)),
      },
    ];
    vi.stubGlobal("useDocker", () => ({
      docker: {
        getContainer: () => ({ getArchive: async () => archive(files) }),
      },
    }));
    await expect(readModOrigins("server", "mods")).resolves.toEqual({});
  });
  it("propagates archive read errors so inventory can report that tracking is unavailable", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("archive failed"));
      },
    });
    vi.stubGlobal("useDocker", () => ({
      docker: { getContainer: () => ({ getArchive: async () => stream }) },
    }));
    await expect(readModOrigins("server", "mods")).rejects.toThrow(
      "archive failed"
    );
  });
  it("removes the source record with the jar so a later file cannot inherit its history", async () => {
    const createContainer = vi.fn(async () => ({
      start: vi.fn(),
      wait: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    }));
    vi.stubGlobal("useDocker", () => ({
      docker: { createContainer },
      getServer: async () => ({ volume: "volume", volumeSource: "volume" }),
    }));
    vi.stubGlobal("useRuntimeConfig", () => ({
      docker: { image: "minecraft" },
    }));
    await deleteJar("server", "mods", jar.name);
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: [
          "-f",
          `/data/mods/${jar.name}`,
          `/data/${modOriginPath("mods", jar.name)}`,
        ],
      })
    );
  });
});
