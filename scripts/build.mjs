import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [
    "better-sqlite3",
    "pg",
    "kysely",
    "zod",
    "commander",
    "env-paths",
    "chokidar",
    "minimatch",
    "@modelcontextprotocol/sdk/*",
  ],
});
if (process.platform !== "win32") await chmod("dist/cli.js", 0o755);
