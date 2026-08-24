import { describe, expect, test } from "bun:test";
import { runModelRenameStartupMigration } from "../src/providers/model-rename-startup";
import type { OcxConfig } from "../src/types";

describe("model rename startup migration", () => {
  test("persists a changed projection exactly once", () => {
    const config = { port: 0, defaultProvider: "google-antigravity", providers: {} } as OcxConfig;
    const saved: OcxConfig[] = [];
    const projected = { ...config, disabledModels: [] };
    const result = runModelRenameStartupMigration(config, {
      project: () => ({
        config: projected,
        changed: true,
        warnings: [],
      }),
      save: next => saved.push(next),
    });
    expect(result).toBe(projected);
    expect(saved).toEqual([projected]);
  });

  test("does not write an unchanged projection", () => {
    const config = { port: 0, defaultProvider: "openai", providers: {} } as OcxConfig;
    let writes = 0;
    expect(runModelRenameStartupMigration(config, {
      project: () => ({ config, changed: false, warnings: [] }),
      save: () => { writes += 1; },
    })).toBe(config);
    expect(writes).toBe(0);
  });
});
