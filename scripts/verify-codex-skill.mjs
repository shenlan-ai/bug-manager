import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
  },
});
const root = process.cwd();
const cli = path.join(root, "dist", "cli.js");
const source = path.join(root, "skills", "bug-manager");
const codex =
  process.env.BUG_MANAGER_CODEX_BIN ??
  (process.platform === "win32" ? "codex.exe" : "codex");
const output = path.resolve(
  values.output ?? path.join(root, "artifacts", "codex-skill-client.json"),
);
if (!output.startsWith(root + path.sep))
  throw new Error("Output must stay inside the repository");

function run(command, args, cwd) {
  const isWindowsShim =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const quoteWindowsArgument = (value) =>
    `"${String(value).replaceAll('"', '""')}"`;
  const result = isWindowsShim
    ? spawnSync([command, ...args].map(quoteWindowsArgument).join(" "), [], {
        cwd,
        encoding: "utf8",
        env: process.env,
        // Node 24 rejects spawning an npm .cmd shim directly on Windows.
        shell: true,
      })
    : spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: process.env,
      });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

async function digest(filename) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

await access(cli);
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "bug-manager-codex-skill-"),
);
try {
  const install = JSON.parse(
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
        temporary,
      ],
      root,
    ),
  ).data;
  if (install.status !== "installed")
    throw new Error("Codex Skill installation did not report installed");

  const sourceHash = await digest(path.join(source, "SKILL.md"));
  const installedSkill = path.join(
    temporary,
    ".agents",
    "skills",
    "bug-manager",
    "SKILL.md",
  );
  const protocol = path.join(
    temporary,
    ".agents",
    "skills",
    "bug-manager",
    "references",
    "protocol.md",
  );
  const installedHash = await digest(installedSkill);
  await access(protocol);
  if (sourceHash !== installedHash)
    throw new Error("Installed Codex Skill differs from the canonical source");

  // This command renders the model-visible prompt without contacting a model.
  const prompt = JSON.parse(
    run(
      codex,
      ["debug", "prompt-input", "maintain the bug prevention library"],
      temporary,
    ),
  );
  const developerText = prompt
    .filter((message) => message.role === "developer")
    .flatMap((message) => message.content ?? [])
    .filter((item) => item.type === "input_text")
    .map((item) => item.text)
    .find((text) => text.includes("<skills_instructions>"));
  if (!developerText)
    throw new Error("Codex did not emit a model-visible Skills section");

  const normalizedTemporary = temporary.replaceAll("\\", "/");
  const rootLine = developerText
    .split("\n")
    .find((line) => line.includes(normalizedTemporary + "/.agents/skills"));
  if (!rootLine)
    throw new Error("Codex did not expose the installed project Skill root");
  const alias = /`(r\d+)`/.exec(rootLine)?.[1];
  if (!alias)
    throw new Error("Codex did not assign an alias to the Skill root");
  const skillLine = developerText
    .split("\n")
    .find((line) => line.startsWith("- bug-manager:"));
  if (
    !skillLine ||
    !skillLine.includes(`(file: ${alias}/bug-manager/SKILL.md)`) ||
    !skillLine.includes("Maintain a type-scoped Bug prevention library")
  )
    throw new Error("Codex did not advertise the installed bug-manager Skill");

  const evidence = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    codex_version: run(codex, ["--version"], root),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    checks: {
      install_status: install.status,
      canonical_skill_hash_matches: true,
      protocol_reference_installed: true,
      discovered_in_model_visible_prompt: true,
      skill_name: "bug-manager",
      skill_entry_path: "bug-manager/SKILL.md",
      model_requests: 0,
    },
    method:
      "Codex debug prompt-input renders the local model-visible prompt without contacting a model. The temporary Skill was installed through the packaged CLI source and removed after verification.",
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
