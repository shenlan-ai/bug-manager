import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = `bug-manager-test-${randomUUID().slice(0, 8)}`;
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || "Docker command failed");
  return r.stdout.trim();
}
try {
  docker([
    "run",
    "--name",
    name,
    "--label",
    "app=bug-manager-test",
    "-e",
    "POSTGRES_PASSWORD=bug-manager-test",
    "-e",
    "POSTGRES_DB=bug_manager_test",
    "-p",
    "127.0.0.1::5432",
    "-d",
    "postgres:16-alpine",
  ]);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", "postgres", "-d", "bug_manager_test"],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("PostgreSQL did not become ready");
  const port = docker(["port", name, "5432/tcp"]).split(":").at(-1);
  const cli = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
  const r = spawnSync(
    process.execPath,
    [cli.pathname.replace(/^\/(\w:)/, "$1"), "run", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BUG_MANAGER_TEST_DATABASE_URL: `postgresql://postgres:bug-manager-test@127.0.0.1:${port}/bug_manager_test`,
      },
    },
  );
  process.exitCode = r.status ?? 1;
} finally {
  docker(["rm", "-f", name]);
}
