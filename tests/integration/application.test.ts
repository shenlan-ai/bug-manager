import { it, expect } from "vitest";
import { Application, configSchema } from "@bug-manager/core";
import { fixture, mutation } from "../helpers.js";

it("uses the shared application contract for structured errors and no-Key type maintenance", async () => {
  const f = await fixture("sqlite");
  try {
    const app = new Application(
      f.store,
      configSchema.parse({
        database: { kind: "sqlite", filename: ":memory:" },
        evidence_dir: f.directory,
      }),
    );
    expect((await app.invoke("config_status", {})).data).toMatchObject({
      analysis_mode: "external",
    });
    const proposed = await app.invoke(
      "type_propose",
      { name: "权限", definition: "角色访问隔离" },
      mutation(),
    );
    expect("error" in proposed).toBe(false);
    expect(
      (
        await app.invoke("type_propose", {
          name: "权限",
          definition: "角色访问隔离",
        })
      ).error,
    ).toMatchObject({ code: "validation_error" });
    expect((await app.invoke("unknown", {})).error).toMatchObject({
      code: "unknown_tool",
    });
  } finally {
    await f.cleanup();
  }
});
