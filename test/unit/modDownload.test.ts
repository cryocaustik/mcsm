import { apiError } from "../fixtures/mods";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadModFile } from "../../server/utils/mods/download";
import { version } from "../fixtures/mods";
import { modInstallFailure } from "../../shared/utils/mods";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const bytes = Buffer.from("jar-content");
const file = version("a", {
  size: bytes.length,
  sha1: createHash("sha1").update(bytes).digest("hex"),
});
describe("verified mod downloads", () => {
  it("downloads and verifies content without sending a provider key or following unchecked redirects", async () => {
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    const result = await downloadModFile(file);
    expect(Buffer.from(result.data)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: "manual",
        headers: { "User-Agent": expect.any(String) },
      })
    );
  });
  it("follows the live CurseForge edge-to-mediafilez redirect and verifies the file", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://mediafilez.forgecdn.net/files/example.jar",
          },
        })
      )
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    const result = await downloadModFile({
      ...file,
      provider: "curseforge",
      downloadUrl: "https://edge.forgecdn.net/files/example.jar",
    });
    expect(Buffer.from(result.data)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://mediafilez.forgecdn.net/files/example.jar"
    );
    for (const [, options] of fetch.mock.calls)
      expect(options.headers).toEqual({ "User-Agent": expect.any(String) });
  });
  it.each([
    "https://attacker.test/file.jar",
    "http://mediafilez.forgecdn.net/file.jar",
    "https://edge.forgecdn.net.attacker.test/file.jar",
    "https://127.0.0.1/file.jar",
  ])(
    "does not contact a rejected redirect destination: %s",
    async (location) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location } })
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        downloadModFile({
          ...file,
          provider: "curseforge",
          downloadUrl: "https://edge.forgecdn.net/files/example.jar",
        })
      ).rejects.toMatchObject({
        data: { modFailure: { code: "DOWNLOAD_HOST_REJECTED" } },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("bounds redirect loops", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "/loop.jar" } })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadModFile(file)).rejects.toMatchObject({
      data: {
        modFailure: { code: "DOWNLOAD_REDIRECT_LIMIT", stage: "download" },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([403, 404, 429, 503])(
    "preserves the upstream HTTP %s with a recovery suggestion",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status }))
      );
      try {
        await downloadModFile(file);
        expect.fail("Expected rejection");
      } catch (error) {
        expect(modInstallFailure(error)).toMatchObject({
          code: "DOWNLOAD_HTTP_ERROR",
          upstreamStatus: status,
          filename: "a.jar",
          host: "cdn.modrinth.com",
          retryable: status >= 500 || status === 429,
          hint: expect.any(String),
        });
      }
    }
  );
  it("distinguishes DNS failures and never exposes the raw fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue({
        message: "private-key",
        cause: { code: "ENOTFOUND" },
        headers: { "x-api-key": "private-key" },
      })
    );
    try {
      await downloadModFile(file);
      expect.fail("Expected rejection");
    } catch (error) {
      expect(modInstallFailure(error)).toMatchObject({
        code: "DOWNLOAD_NETWORK_ERROR",
        networkCode: "ENOTFOUND",
        hint: expect.stringContaining("DNS"),
      });
      expect(JSON.stringify(error)).not.toContain("private-key");
    }
  });
  it("distinguishes a timeout from other network errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            )
          )
      )
    );
    const result = expect(downloadModFile(file)).rejects.toMatchObject({
      statusCode: 504,
      data: { modFailure: { code: "DOWNLOAD_TIMEOUT", retryable: true } },
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await result;
  });
  it("identifies a checksum mismatch independently of download size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes))
    );
    await expect(
      downloadModFile({ ...file, sha1: "a".repeat(40) })
    ).rejects.toMatchObject({
      data: {
        modFailure: { code: "DOWNLOAD_HASH_MISMATCH", stage: "download" },
      },
    });
  });
  it.each([
    "http://cdn.modrinth.com/a.jar",
    "https://cdn.modrinth.com.evil.test/a.jar",
    "https://cdn.modrinth.com:444/a.jar",
    "https://user:password@cdn.modrinth.com/a.jar",
    "https://127.0.0.1/a.jar",
  ])("rejects unsafe URLs: %s", async (downloadUrl) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadModFile({ ...file, downloadUrl })
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "../escape.jar",
    "nested/file.jar",
    "nested\\file.jar",
    "file.jar\n",
    "file.zip",
  ])("rejects unsafe filenames: %j", async (filename) => {
    await expect(downloadModFile({ ...file, filename })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
  it("respects third-party download restrictions", async () => {
    await expect(
      downloadModFile({ ...file, provider: "curseforge", downloadUrl: null })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("rejects files over the cap before requesting them", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadModFile({ ...file, size: 101 * 1024 * 1024 })
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects corrupt or truncated content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad"))
    );
    await expect(downloadModFile(file)).rejects.toMatchObject({
      statusCode: 502,
    });
  });
  it("aborts a response that streams more than declared", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        signal = options.signal;
        return new Response(bytes);
      })
    );
    await expect(downloadModFile({ ...file, size: 1 })).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(signal?.aborted).toBe(true);
  });
});

beforeEach(() => vi.stubGlobal("createError", apiError));
