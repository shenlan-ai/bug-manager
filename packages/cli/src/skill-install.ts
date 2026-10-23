import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, id } from "@bug-manager/core";

const schema = z
  .object({
    client: z.enum(["codex", "claude"]),
    scope: z.enum(["user", "project"]),
    root: z.string().min(1),
  })
  .strict();
async function inspect(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function safeAncestors(directory: string) {
  let current = path.resolve(directory);
  while (true) {
    const entry = await inspect(current);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new DomainError(
        "skill_path_unsafe",
        "Skill installation requires real directories without symbolic links",
      );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function contents(
  directory: string,
  prefix = "",
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new DomainError(
        "skill_conflict",
        "Skill directories must not contain symbolic links",
      );
    if (entry.isDirectory())
      for (const [key, value] of await contents(directory, relative))
        result.set(key, value);
    else if (entry.isFile())
      result.set(relative, await readFile(path.join(directory, relative)));
    else
      throw new DomainError(
        "skill_conflict",
        "Unsupported entry in Skill directory",
      );
  }
  return result;
}
export async function installSkill(raw: unknown, source: string) {
  const input = schema.parse(raw),
    root = path.resolve(input.root),
    parent = path.join(
      root,
      input.client === "codex" ? ".agents" : ".claude",
      "skills",
    ),
    destination = path.join(parent, "bug-manager");
  await safeAncestors(destination);
  const files = await contents(source);
  if (!files.has("SKILL.md"))
    throw new DomainError(
      "skill_asset_missing",
      "Packaged product Skill is missing",
    );
  if (await inspect(destination)) {
    const previous = await contents(destination);
    if (
      previous.size !== files.size ||
      [...files].some(([key, value]) => !previous.get(key)?.equals(value))
    )
      throw new DomainError(
        "skill_conflict",
        "A different Skill already exists. Preserve or move it explicitly before installing",
      );
    return {
      client: input.client,
      scope: input.scope,
      destination,
      status: "unchanged",
    };
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await safeAncestors(parent);
  const staging = path.join(parent, `.bug-manager-install-${id()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [relative, data] of files) {
      const filename = path.join(staging, relative);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, data, { flag: "wx", mode: 0o600 });
    }
    await safeAncestors(destination);
    if (await inspect(destination))
      throw new DomainError(
        "skill_conflict",
        "Skill destination changed during installation; retry",
      );
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    client: input.client,
    scope: input.scope,
    destination,
    status: "installed",
  };
}
