/** Model-tier defaults and effective-model resolution.
 *  Public interfaces are model-driven; tiers provide a stable capability floor
 *  that can be mapped to concrete model IDs over time. */

export type ModelTier = "fast" | "standard" | "strong" | "frontier";

export const DEFAULT_MODEL_BY_TIER: Record<ModelTier, string> = {
  fast: "gpt-5.1-codex-mini",
  standard: "gpt-5.4-mini",
  strong: "gpt-5.3-codex",
  frontier: "gpt-5.4",
};

export const DEFAULT_MODEL_TIER: ModelTier = "strong";

const TIER_RANK: Record<ModelTier, number> = {
  fast: 0,
  standard: 1,
  strong: 2,
  frontier: 3,
};

const LEGACY_ALIAS_TO_TIER: Record<string, ModelTier> = {
  // Back-compat aliases from old scheduler profiles/prompts.
  haiku: "fast",
  sonnet: "standard",
  opus: "frontier",
};

function normalize(model: string): string {
  return model.trim().toLowerCase();
}

export function inferModelTier(model?: string): ModelTier | undefined {
  if (!model?.trim()) return undefined;
  const candidate = normalize(model);

  if (candidate in TIER_RANK) return candidate as ModelTier;
  if (candidate in LEGACY_ALIAS_TO_TIER) return LEGACY_ALIAS_TO_TIER[candidate];

  for (const [tier, modelName] of Object.entries(DEFAULT_MODEL_BY_TIER) as Array<[ModelTier, string]>) {
    if (candidate === modelName.toLowerCase()) return tier;
  }

  // Heuristic support for common GPT naming variants.
  if (candidate.startsWith("gpt-5.4-mini")) return "standard";
  if (candidate.startsWith("gpt-5.4")) return "frontier";
  if (candidate.startsWith("gpt-5.3")) return "strong";
  if (candidate.startsWith("gpt-5.2")) return "strong";
  if (candidate.startsWith("gpt-5.1") && candidate.includes("mini")) return "fast";

  return undefined;
}

function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Resolve a concrete model for the requested model + optional minimum tier floor.
 *  Unknown explicit model strings are preserved (no forced rewrite). */
export function computeEffectiveModel(
  requestedModel?: string,
  minimumTier?: ModelTier,
): string {
  const requested = requestedModel?.trim();
  const requestedTier = inferModelTier(requested);

  if (!requested) {
    const tier = minimumTier ?? DEFAULT_MODEL_TIER;
    return DEFAULT_MODEL_BY_TIER[tier];
  }

  if (!minimumTier) {
    return requestedTier ? DEFAULT_MODEL_BY_TIER[requestedTier] : requested;
  }

  if (!requestedTier) {
    return requested;
  }

  const effectiveTier = maxTier(requestedTier, minimumTier);
  return DEFAULT_MODEL_BY_TIER[effectiveTier];
}

