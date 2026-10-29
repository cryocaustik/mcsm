import { modInstallFailure } from "../../shared/utils/mods";

/** Prefer structured reasons and the response body over generic HTTP status text. */
export function errorMessage(error: unknown, fallback: string): string {
  const fetchError = error as {
    data?: { statusMessage?: string; message?: string };
    statusMessage?: string;
    message?: string;
  };
  return (
    modInstallFailure(error)?.message ||
    fetchError?.data?.statusMessage ||
    fetchError?.data?.message ||
    fetchError?.statusMessage ||
    fallback
  );
}
