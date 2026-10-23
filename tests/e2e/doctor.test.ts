import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { configSchema, id } from "@bug-manager/core";

it("API-002/DB-006 prints valid templates, diagnoses unavailable services and missing model keys without exposing credentials", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "bug-manager-doctor-")),
    cli = path.resolve("dist/cli.js"),
    envName = `BUG_MANAGER_DOCTOR_${id().replaceAll("-", "")}`;
  const invoke = (args: string[]) =>
    execFileSync(process.execPath, [cli, "--home", home, "--json", ...args], {
      encoding: "utf8",
    });
  try {
    const template = JSON.parse(
      invoke(["config", "template", "--database", "postgres", "--model"]),
    ).data;
    expect(configSchema.parse(template).database.kind).toBe("postgres");
    expect(template.model.api_key_env).toBe("BUG_MANAGER_MODEL_KEY");
    expect(template.history).toEqual([]);
    invoke(["init"]);
    const config = JSON.parse(
      await readFile(path.join(home, "config.json"), "utf8"),
    );
    config.model = { ...template.model, api_key_env: envName };
    await writeFile(path.join(home, "config.json"), JSON.stringify(config));
    expect(JSON.parse(invoke(["doctor"])).data.model).toEqual({
      configured: true,
      key_available: false,
    });
    expect(JSON.parse(invoke(["worker", "status"])).data.workers).toEqual([]);
    const schema = JSON.parse(invoke(["tools", "--name", "analysis_submit"]));
    expect(schema.data.input_schema.properties).toHaveProperty("proposal");
    try {
      invoke(["types", "list", "--input", "{"]);
      throw new Error("Expected invalid input");
    } catch (error) {
      expect(
        JSON.parse(String((error as { stdout: string }).stdout)).error,
      ).toMatchObject({ code: "invalid_json", retryable: false });
    }
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Expected port");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    process.env[envName] =
      `postgresql://synthetic:NEVER_LEAK_SYNTHETIC_PASSWORD@127.0.0.1:${address.port}/synthetic`;
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        ...config,
        database: { kind: "postgres", url_env: envName },
      }),
    );
    try {
      invoke(["doctor"]);
      throw new Error("Expected unavailable database");
    } catch (error) {
      expect(error).toHaveProperty("status", 1);
      const stdout = String((error as { stdout: string }).stdout);
      expect(JSON.parse(stdout).error.code).toBe("connection_unavailable");
      expect(stdout).not.toContain("NEVER_LEAK");
      expect(stdout).not.toContain("postgresql://");
    }
  } finally {
    delete process.env[envName];
    await rm(home, { recursive: true, force: true });
  }
});
