import { afterEach, expect, it } from "vitest";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
it("installs the canonical Skill explicitly for both clients/scopes, preserves conflicts and blocks symlink escapes", async () => {
  temporary = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "bug-manager-skills-"),
  );
  const cli = path.resolve("dist/cli.js"),
    source = await readFile("skills/bug-manager/SKILL.md", "utf8");
  function install(client: string, scope: string, root: string) {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          "--json",
          "skill",
          "install",
          "--client",
          client,
          "--scope",
          scope,
          "--root",
          root,
        ],
        { encoding: "utf8" },
      ),
    ).data;
  }
  for (const client of ["codex", "claude"])
    for (const scope of ["user", "project"]) {
      const root = path.join(temporary, `${client}-${scope}`),
        parent = path.join(
          root,
          client === "codex" ? ".agents" : ".claude",
          "skills",
        ),
        unrelated = path.join(parent, "unrelated");
      await mkdir(unrelated, { recursive: true });
      await writeFile(path.join(unrelated, "SKILL.md"), "Unrelated skill");
      const first = install(client, scope, root);
      expect(first.status).toBe("installed");
      expect(
        await readFile(path.join(first.destination, "SKILL.md"), "utf8"),
      ).toBe(source);
      expect(install(client, scope, root).status).toBe("unchanged");
      expect(await readFile(path.join(unrelated, "SKILL.md"), "utf8")).toBe(
        "Unrelated skill",
      );
      const conflict = path.join(first.destination, "references", "custom.txt");
      await writeFile(conflict, "User customization");
      try {
        install(client, scope, root);
        throw new Error("Expected conflict");
      } catch (error) {
        expect(error).toHaveProperty("status", 1);
        expect(
          JSON.parse(String((error as { stdout: string }).stdout)).error.code,
        ).toBe("skill_conflict");
      }
      expect(await readFile(conflict, "utf8")).toBe("User customization");
      expect(await readdir(parent)).toEqual(
        expect.arrayContaining(["bug-manager", "unrelated"]),
      );
    }
  const root = path.join(temporary, "linked-project"),
    external = path.join(temporary, "outside");
  await mkdir(root);
  await mkdir(external);
  await symlink(
    external,
    path.join(root, ".agents"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    install("codex", "project", root);
    throw new Error("Expected unsafe path");
  } catch (error) {
    expect(error).toHaveProperty("status", 1);
    expect(
      JSON.parse(String((error as { stdout: string }).stdout)).error.code,
    ).toBe("skill_path_unsafe");
  }
  await expect(access(path.join(external, "skills"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});
