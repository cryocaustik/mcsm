import type {
  ModInstallFailure,
  ModInstallStage,
  ModProvider,
} from "../../../shared/types/mods";
import { modInstallFailure } from "../../../shared/utils/mods";

export function modError(statusCode: number, failure: ModInstallFailure) {
  return createError({
    statusCode,
    statusMessage: failure.message,
    data: { modFailure: failure },
  });
}

export function reportModInstallFailure(
  error: unknown,
  context: {
    provider: ModProvider;
    stage: ModInstallStage;
    projectId: string;
    requestId: string;
    serverId: string;
  }
) {
  const { serverId, ...details } = context;
  const known = error as { statusCode?: number; statusMessage?: string } | null;
  const statusCode =
    known?.statusCode && known.statusCode >= 400 && known.statusCode <= 599
      ? known.statusCode
      : 500;
  const failure: ModInstallFailure = {
    ...details,
    code: "INSTALL_FAILED",
    message: known?.statusMessage || "Mod installation failed unexpectedly.",
    retryable: false,
    hint: "Refresh the installed list before trying again. Include the reference ID when reporting this failure.",
    ...modInstallFailure(error),
    requestId: context.requestId,
  };
  console.error("[mcsm] Mod installation failed", { ...failure, serverId });
  return modError(statusCode, failure);
}

/** Only known network codes are safe to expose; never serialize a FetchError. */
export function modNetworkCode(error: unknown): string | undefined {
  const codes = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "UND_ERR_CONNECT_TIMEOUT",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ]);
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && codes.has(code)) return code;
    current = cause;
  }
}
