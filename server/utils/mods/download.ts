import { createHash } from "node:crypto";
import type { ModInstallFailure } from "../../../shared/types/mods";
import { modInstallFailure } from "../../../shared/utils/mods";
import { modError, modNetworkCode } from "./errors";
import type { ModVersion } from "./types";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOSTS = {
  modrinth: ["cdn.modrinth.com"],
  curseforge: [
    "edge.forgecdn.net",
    "media.forgecdn.net",
    "mediafilez.forgecdn.net",
  ],
};

/** Stream verified files, checking every redirect before contacting its destination. */
export async function downloadModFile(version: ModVersion) {
  const context = {
    provider: version.provider,
    stage: "download" as const,
    projectId: version.projectId,
    filename: version.filename,
  };
  function fail(
    code: string,
    message: string,
    hint: string,
    options: Partial<ModInstallFailure> = {},
    statusCode = 502
  ) {
    return modError(statusCode, {
      ...context,
      code,
      message,
      hint,
      retryable: false,
      ...options,
    });
  }
  function validateUrl(value: string, base?: URL): URL {
    let parsed: URL;
    try {
      parsed = new URL(value, base);
    } catch {
      throw fail(
        "DOWNLOAD_URL_INVALID",
        "The provider returned an invalid download URL.",
        "Open the source page to check whether the file is still available."
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443") ||
      !HOSTS[version.provider].includes(parsed.hostname)
    ) {
      throw fail(
        "DOWNLOAD_HOST_REJECTED",
        "The provider returned a download destination that is not allowed.",
        "Open the source page to download manually, or report this failure with its reference ID."
      );
    }
    return parsed;
  }
  if (!version.downloadUrl)
    throw fail(
      "DOWNLOAD_RESTRICTED",
      "The author has disabled third-party downloads.",
      "Download this file from its source page and upload it manually.",
      {},
      409
    );
  let url = validateUrl(version.downloadUrl);
  if (
    !/^[^/\\]+\.jar$/i.test(version.filename) ||
    [...version.filename].some((char) => char.charCodeAt(0) < 32) ||
    !/^[a-f0-9]{40}$/i.test(version.sha1) ||
    !Number.isSafeInteger(version.size) ||
    version.size < 0
  ) {
    throw fail(
      "DOWNLOAD_METADATA_INVALID",
      "The provider returned invalid file metadata.",
      "Try a different build or download the file manually from its source page."
    );
  }
  if (version.size > MAX_BYTES)
    throw fail(
      "DOWNLOAD_TOO_LARGE",
      "Mod file exceeds the 100 MB limit.",
      "Choose a smaller build.",
      {},
      413
    );

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 60_000);
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "mcsm (github.com/cryocaustik/mcsm)" },
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS)
        throw fail(
          "DOWNLOAD_REDIRECT_LIMIT",
          "The download exceeded the redirect limit.",
          "Try again later or use the source page to download manually.",
          { host: url.hostname }
        );
      const location = response.headers.get("location");
      if (!location)
        throw fail(
          "DOWNLOAD_REDIRECT_INVALID",
          "The download server returned a redirect without a destination.",
          "Try again later or download from the source page.",
          { host: url.hostname }
        );
      url = validateUrl(location, url);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(
        "DOWNLOAD_HTTP_ERROR",
        `The download server returned HTTP ${response.status} for "${version.filename}".`,
        response.status === 401 || response.status === 403
          ? "The CDN denied access. Try downloading from the source page and uploading the file manually."
          : response.status === 404
            ? "The file may have been removed. Refresh the search or open the source page."
            : "Try again shortly. If this continues, check the provider's availability.",
        {
          host: url.hostname,
          upstreamStatus: response.status,
          retryable: response.status === 429 || response.status >= 500,
        }
      );
    }
    if (!response.body)
      throw fail(
        "DOWNLOAD_EMPTY",
        "The download server returned an empty response.",
        "Try downloading the file again.",
        { host: url.hostname, retryable: true }
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES || size > version.size) {
          controller.abort();
          throw fail(
            "DOWNLOAD_SIZE_MISMATCH",
            "The downloaded file exceeds its declared size.",
            "Retry the download. If this repeats, use the source page to check the file.",
            { host: url.hostname, retryable: true }
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== version.size)
      throw fail(
        "DOWNLOAD_SIZE_MISMATCH",
        `The download was incomplete (${size} of ${version.size} bytes).`,
        "Retry the download. No files from this installation have been written.",
        { host: url.hostname, retryable: true }
      );
    const data = Buffer.concat(chunks);
    if (
      createHash("sha1").update(data).digest("hex") !==
      version.sha1.toLowerCase()
    )
      throw fail(
        "DOWNLOAD_HASH_MISMATCH",
        "The downloaded file failed its SHA-1 integrity check.",
        "Retry the download. If this repeats, check the file on its source page.",
        { host: url.hostname, retryable: true }
      );
    return { name: version.filename, data: new Uint8Array(data) };
  } catch (error) {
    if (modInstallFailure(error)) throw error;
    const networkCode = modNetworkCode(error);
    if (
      timedOut ||
      networkCode === "ETIMEDOUT" ||
      networkCode === "UND_ERR_CONNECT_TIMEOUT"
    )
      throw fail(
        "DOWNLOAD_TIMEOUT",
        "The mod download timed out.",
        "Retry the download and check the server's outbound connection if it continues.",
        { host: url.hostname, networkCode, retryable: true },
        504
      );
    throw fail(
      "DOWNLOAD_NETWORK_ERROR",
      "The server could not connect to the mod download host.",
      networkCode === "ENOTFOUND" || networkCode === "EAI_AGAIN"
        ? "Check DNS resolution and outbound network access on the MCSM host, then retry."
        : "Check outbound HTTPS access on the MCSM host, then retry.",
      { host: url.hostname, networkCode, retryable: true }
    );
  } finally {
    clearTimeout(timeout);
  }
}
