import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "../fixtures/mods";
import {
  modError,
  reportModInstallFailure,
} from "../../server/utils/mods/errors";
import { modInstallFailure } from "../../shared/utils/mods";
import { errorMessage } from "../../app/utils/errors";

beforeEach(() => vi.stubGlobal("createError", apiError));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const failure = {
  code: "DOWNLOAD_HTTP_ERROR",
  message: "The download server returned HTTP 403.",
  provider: "curseforge" as const,
  retryable: false,
  stage: "download" as const,
  upstreamStatus: 403,
  projectId: "dependency-id",
  filename: "dependency.jar",
};

describe("mod failure diagnostics", () => {
  it("extracts structured reasons from both H3 and ofetch errors", () => {
    const serverError = modError(502, failure);
    expect(modInstallFailure(serverError)).toEqual(failure);
    const fetchError = {
      statusMessage: "Bad Gateway",
      data: { statusMessage: "Bad Gateway", data: { modFailure: failure } },
    };
    expect(modInstallFailure(fetchError)).toEqual(failure);
    expect(errorMessage(fetchError, "Installation failed")).toBe(
      failure.message
    );
  });
  it("reads a JSON error message before the generic HTTP status text", () => {
    expect(
      errorMessage(
        {
          statusMessage: "Bad Gateway",
          data: { message: "CurseForge rejected the request" },
        },
        "Failed"
      )
    ).toBe("CurseForge rejected the request");
    expect(errorMessage(null, "Failed")).toBe("Failed");
  });
  it("preserves dependency details and correlates the user error with a sanitized log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = reportModInstallFailure(modError(502, failure), {
      provider: "curseforge",
      projectId: "parent-project",
      stage: "resolve",
      requestId: "reference-123",
      serverId: "server",
    });
    expect(modInstallFailure(error)).toMatchObject({
      ...failure,
      requestId: "reference-123",
    });
    expect(log).toHaveBeenCalledWith(
      "[mcsm] Mod installation failed",
      expect.objectContaining({
        requestId: "reference-123",
        upstreamStatus: 403,
        filename: "dependency.jar",
        serverId: "server",
      })
    );
  });
  it("redacts unexpected upstream error text, headers and stack traces", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = reportModInstallFailure(
      {
        message: "secret-key",
        stack: "secret-key",
        headers: { "x-api-key": "secret-key" },
      },
      {
        provider: "curseforge",
        projectId: "123",
        stage: "identify",
        requestId: "ref",
        serverId: "server",
      }
    );
    expect(modInstallFailure(error)).toMatchObject({
      code: "INSTALL_FAILED",
      stage: "identify",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("secret-key");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-key");
  });
});
