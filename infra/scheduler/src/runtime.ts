import type { BackendName } from "./backend.js";

/**
 * Internal observability label for which runtime/route actually executed a session.
 * This is intentionally not exposed as a user-facing selector (users pick `model`).
 */
export type RuntimeRoute = "codex_cli" | "openai_fallback";

export function runtimeRouteForBackend(backend: BackendName): RuntimeRoute {
  switch (backend) {
    case "codex":
      return "codex_cli";
    case "openai":
      return "openai_fallback";
  }
}

/** Back-compat: convert legacy persisted `backend` strings into a RuntimeRoute. */
export function runtimeRouteFromLegacyBackend(backend: unknown): RuntimeRoute {
  const raw = typeof backend === "string" ? backend.trim().toLowerCase() : "";
  if (!raw) return "codex_cli";
  if (raw === "openai") return "openai_fallback";
  // Historical values: claude/codex/auto all map to the default codex route.
  return "codex_cli";
}
