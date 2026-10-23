import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run test:package");
const root = process.cwd(),
  temporary = await mkdtemp(path.join(os.tmpdir(), "bug-manager-package-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(
      `Package smoke command failed: ${result.stderr || result.stdout || result.error}`,
    );
  return result.stdout;
}
try {
  const packed = JSON.parse(
    run(
      process.execPath,
      [npm, "pack", "--json", "--pack-destination", temporary],
      { cwd: root },
    ),
  )[0];
  if (
    packed.files.some((f) =>
      /node_modules|\.sqlite|sessions\/|\.env$/.test(f.path),
    )
  )
    throw new Error("Private or runtime data leaked into npm package");
  if (!packed.files.some((f) => f.path === "dist/cli.js"))
    throw new Error("Packaged executable is missing");
  if (!packed.files.some((f) => f.path === "skills/bug-manager/SKILL.md"))
    throw new Error("Packaged product Skill is missing");
  const install = path.join(temporary, "consumer");
  await mkdir(install);
  const sourcePackage = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(install, "package.json"),
    JSON.stringify({
      name: "synthetic-package-smoke",
      private: true,
      allowScripts: sourcePackage.allowScripts,
    }),
  );
  run(
    process.execPath,
    [
      npm,
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, packed.filename),
    ],
    { cwd: install },
  );
  const cli = path.join(
      install,
      "node_modules",
      "bug-manager",
      "dist",
      "cli.js",
    ),
    home = path.join(temporary, "data");
  const initialized = JSON.parse(
    run(process.execPath, [cli, "--home", home, "--json", "init"], {
      cwd: install,
    }),
  );
  if (initialized.data.database !== "sqlite")
    throw new Error("Installed CLI did not initialize SQLite");
  const doctor = JSON.parse(
    run(process.execPath, [cli, "--home", home, "--json", "doctor"], {
      cwd: install,
    }),
  );
  if (doctor.data.available !== true)
    throw new Error("Installed CLI health failed");
  const skillRoot = path.join(temporary, "skill-project");
  const skill = JSON.parse(
    run(
      process.execPath,
      [
        cli,
        "--json",
        "skill",
        "install",
        "--client",
        "codex",
        "--scope",
        "project",
        "--root",
        skillRoot,
      ],
      { cwd: install },
    ),
  );
  if (
    skill.data.status !== "installed" ||
    !(
      await readFile(path.join(skill.data.destination, "SKILL.md"), "utf8")
    ).includes("name: bug-manager")
  )
    throw new Error(
      "Installed package Skill could not be installed independently",
    );
  const mcp = new Client({
      name: "synthetic-package-smoke",
      version: "1.0.0",
    }),
    mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--home", home, "mcp", "serve"],
      cwd: install,
      stderr: "pipe",
    });
  try {
    await mcp.connect(mcpTransport);
    const tools = await mcp.listTools();
    if (!tools.tools.some((tool) => tool.name === "knowledge_apply"))
      throw new Error("Installed MCP server did not expose knowledge_apply");
    const status = await mcp.callTool({
      name: "config_status",
      arguments: { input: {} },
    });
    if (status.isError)
      throw new Error("Installed MCP server could not invoke config_status");
  } finally {
    await mcp.close();
  }
  const history = path.join(temporary, "history"),
    configPath = path.join(home, "config.json");
  await mkdir(history);
  await writeFile(
    path.join(history, "synthetic.jsonl"),
    [
      { type: "session_meta", payload: { id: "package-worker-smoke" } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Synthetic package worker smoke",
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.history = [{ adapter: "codex", path: history, exclude: [] }];
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const worker = spawn(
      process.execPath,
      [cli, "--home", home, "--json", "worker", "run", "--interval-ms", "100"],
      {
        cwd: install,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    ),
    workerExit = new Promise((resolve) => {
      worker.once("exit", (code, signal) => resolve({ code, signal }));
      worker.once("error", (error) => resolve({ error }));
    });
  let workerStdout = "",
    workerStderr = "",
    pendingSegments = 0;
  worker.stdout.on("data", (chunk) => {
    workerStdout += String(chunk);
  });
  worker.stderr.on("data", (chunk) => {
    workerStderr += String(chunk);
  });
  let workerStopTimedOut = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (worker.exitCode !== null || worker.signalCode !== null)
        throw new Error(
          `Installed worker exited before observation: ${workerStderr || workerStdout}`,
        );
      const status = JSON.parse(
        run(
          process.execPath,
          [cli, "--home", home, "--json", "worker", "status"],
          {
            cwd: install,
          },
        ),
      );
      if (
        status.data.workers.some((entry) => entry.alive) &&
        status.data.analysis.pending_segments > 0
      ) {
        pendingSegments = status.data.analysis.pending_segments;
        break;
      }
      await delay(100);
    }
    if (!pendingSegments)
      throw new Error(
        `Installed worker did not scan the synthetic history: ${workerStderr || workerStdout}`,
      );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    const stopped = await Promise.race([
      workerExit.then(() => true),
      delay(5000).then(() => false),
    ]);
    if (!stopped) {
      workerStopTimedOut = true;
      worker.kill("SIGKILL");
      await Promise.race([workerExit, delay(2000)]);
    }
  }
  if (workerStopTimedOut)
    throw new Error("Installed worker did not stop after package smoke");
  const evidence = {
    package: packed.name,
    version: packed.version,
    sha: packed.shasum,
    files: packed.files.length,
    size_bytes: packed.size,
    installed_cli: true,
    installed_skill: true,
    started_mcp: true,
    started_worker: true,
    worker_pending_segments: pendingSegments,
    database: "sqlite",
    platform: process.platform,
    node: process.version,
  };
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts", "package-smoke.json"),
    JSON.stringify(evidence, null, 2),
  );
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
