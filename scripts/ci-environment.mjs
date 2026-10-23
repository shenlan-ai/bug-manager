import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
const environment = {
  generated_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  os_release: os.release(),
  logical_cores: os.cpus().length,
  host_memory_bytes: os.totalmem(),
  postgres_tests_configured: Boolean(process.env.BUG_MANAGER_TEST_DATABASE_URL),
};
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/environment.json",
  JSON.stringify(environment, null, 2),
);
process.stdout.write(JSON.stringify(environment) + "\n");
