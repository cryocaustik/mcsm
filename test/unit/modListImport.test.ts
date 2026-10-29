import { describe, expect, it, vi } from "vitest";
import { runModImport, type ModImportRow } from "../../app/utils/mod-import";
const row = (id: string, dependency = false): ModImportRow => ({
  entry: { provider: "modrinth", projectId: id, dependency },
  status: "ready",
});
const added = [{ filename: "a.jar", version_number: "1", dependency: false }];

describe("mod list import progress", () => {
  it("installs roots before explicit dependencies and reports each result", async () => {
    const rows = [row("dep", true), row("root")];
    const install = vi.fn(
      async (
        _entry: import("../../shared/types/mod-list").ModListDownload
      ) => ({ added, restarted: false })
    );
    const onResult = vi.fn();
    expect(await runModImport(rows, { install, onResult })).toEqual({
      added: 2,
    });
    expect(install.mock.calls.map(([entry]) => entry.projectId)).toEqual([
      "root",
      "dep",
    ]);
    expect(rows.every((row) => row.status === "installed")).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(2);
  });
  it("distinguishes retained mods with repaired dependencies from unchanged files", async () => {
    const rows = [row("a"), row("b")];
    const install = vi
      .fn()
      .mockResolvedValueOnce({
        added: [{ ...added[0], dependency: true }],
        restarted: false,
        alreadyInstalled: true,
      })
      .mockResolvedValueOnce({
        added: [],
        restarted: false,
        alreadyInstalled: true,
      });
    expect(await runModImport(rows, { install })).toEqual({ added: 1 });
    expect(rows.map((row) => row.status)).toEqual(["repaired", "skipped"]);
  });
  it("retains failure reasons and continues with other entries", async () => {
    const rows = [row("a"), row("b")];
    const install = vi
      .fn()
      .mockRejectedValueOnce({
        data: {
          data: {
            modFailure: {
              provider: "modrinth",
              code: "MISSING_DEPENDENCY",
              message: "Required dependency is incompatible",
              retryable: false,
              hint: "Choose another version",
              requestId: "reference-1",
            },
          },
        },
      })
      .mockResolvedValueOnce({ added, restarted: false });
    await runModImport(rows, { install });
    expect(rows[0]).toMatchObject({
      status: "failed",
      message: "Required dependency is incompatible",
      hint: "Choose another version",
      reference: "reference-1",
    });
    expect(rows[1]?.status).toBe("installed");
  });
  it("stops before the next request without interrupting the current write", async () => {
    const rows = [row("a"), row("b")];
    let stop = false;
    const install = vi.fn(async () => {
      stop = true;
      return { added, restarted: false };
    });
    await runModImport(rows, { install, shouldStop: () => stop });
    expect(install).toHaveBeenCalledTimes(1);
    expect(rows[0]?.status).toBe("installed");
    expect(rows[1]?.status).toBe("ready");
  });
  it("does not attempt to download private/manual jars", async () => {
    const rows: ModImportRow[] = [
      {
        entry: {
          provider: "manual",
          filename: "private.jar",
          dependency: false,
        },
        status: "ready",
      },
    ];
    const install = vi.fn();
    await runModImport(rows, { install });
    expect(install).not.toHaveBeenCalled();
    expect(rows[0]?.status).toBe("manual");
  });
  it("can retry failures without carrying forward the previous diagnostics", async () => {
    const rows = [
      {
        ...row("a"),
        status: "failed" as const,
        message: "old error",
        hint: "old hint",
        reference: "old reference",
      },
    ];
    await runModImport(rows, {
      install: async () => ({ added, restarted: false }),
    });
    expect(rows[0]).toMatchObject({
      status: "installed",
      message: undefined,
      hint: undefined,
      reference: undefined,
    });
  });
});
