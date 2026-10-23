import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import { z } from "zod";
import { DomainError } from "./errors.js";
import { CURRENT_ANALYSIS_VERSION } from "./history/versions.js";

export const configSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    database: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("sqlite"), filename: z.string().min(1) }),
      z.object({ kind: z.literal("postgres"), url_env: z.string().min(1) }),
    ]),
    evidence_dir: z.string().min(1),
    embeddings: z
      .object({
        enabled: z.boolean().default(false),
        model_id: z.string().min(1).max(200),
        dimensions: z.number().int().min(1).max(4096),
        normalization_version: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    model: z
      .object({
        base_url: z.url(),
        model: z.string().min(1),
        api_key_env: z.string().min(1),
        protocol: z
          .enum(["chat-completions", "responses"])
          .default("chat-completions"),
        timeout_ms: z.number().int().positive().default(60_000),
        max_requests: z.number().int().positive().default(100),
        max_context_chars: z.number().int().positive().default(48_000),
        max_output_tokens: z.number().int().min(128).max(32000).default(4000),
        max_tokens: z.number().int().positive().default(200000),
        max_retries: z.number().int().min(0).max(5).default(2),
        response_format: z
          .enum(["auto", "json_schema", "json_object", "text"])
          .default("auto"),
        strategy_version: z
          .string()
          .min(1)
          .max(100)
          .default(CURRENT_ANALYSIS_VERSION),
      })
      .optional(),
    history: z
      .array(
        z.object({
          adapter: z.enum(["codex", "claude"]),
          path: z.string().min(1),
          exclude: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    privacy: z
      .object({
        version: z.string().min(1).max(100).default("1"),
        patterns: z.array(z.string().min(1).max(1000)).max(100).default([]),
      })
      .optional(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const dataHome = () =>
  path.resolve(
    process.env.BUG_MANAGER_HOME ??
      envPaths("bug-manager", { suffix: "" }).data,
  );
export async function loadConfig(home = dataHome()): Promise<Config> {
  try {
    return configSchema.parse(
      JSON.parse(await readFile(path.join(home, "config.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new DomainError("not_initialized", "Run bug-manager init first");
    throw error;
  }
}
export async function initializeConfig(home = dataHome()): Promise<Config> {
  await mkdir(home, { recursive: true });
  const config = configSchema.parse({
    database: { kind: "sqlite", filename: path.join(home, "library.sqlite") },
    evidence_dir: path.join(home, "evidence"),
  });
  try {
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(config, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return loadConfig(home);
    throw error;
  }
  return config;
}
