import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { readBudgets } from "./data-budget.js";

describe("lightweight budget reporting", () => {
  it("reads budget and ledger files without external audit tooling", async () => {
    const repo = await mkdtemp(join(tmpdir(), "a-exp-budget-"));
    try {
      const project = join(repo, "projects", "demo");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "budget.yaml"), [
        "resources:",
        "  llm_api_calls:",
        "    limit: 100",
        "    unit: calls",
        "deadline: 2026-06-01T00:00:00Z",
        "",
      ].join("\n"));
      await writeFile(join(project, "ledger.yaml"), [
        "entries:",
        "  - date: 2026-04-29",
        "    resource: llm_api_calls",
        "    amount: 25",
        "    note: smoke",
        "",
      ].join("\n"));

      const budgets = await readBudgets(repo);
      expect(budgets).toHaveLength(1);
      expect(budgets[0].resources[0]).toMatchObject({
        resource: "llm_api_calls",
        consumed: 25,
        limit: 100,
        unit: "calls",
        pct: 25,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
