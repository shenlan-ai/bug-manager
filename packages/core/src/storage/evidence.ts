import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { invariant } from "../errors.js";
import { hash, now } from "../util.js";
import { redact } from "../privacy.js";

const within = (base: string, target: string) => {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};
export async function readStableEvidenceFile(
  file: Pick<FileHandle, "stat" | "read">,
  maxBytes: number,
) {
  const info = await file.stat();
  invariant(
    info.isFile() && info.size <= maxBytes,
    "invalid_evidence_size",
    "Evidence must be a file within the size limit",
  );
  const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (!bytesRead) break;
    offset += bytesRead;
  }
  invariant(
    offset === info.size,
    "invalid_evidence_size",
    "Evidence changed size during read",
  );
  return buffer.subarray(0, offset);
}
export class EvidenceStore {
  constructor(
    readonly root: string,
    readonly maxBytes = 32 * 1024 * 1024,
    readonly patterns: RegExp[] = [],
  ) {}
  async initialize() {
    await mkdir(path.join(this.root, "inbox"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(this.root, "objects"), {
      recursive: true,
      mode: 0o700,
    });
    const root = await realpath(this.root);
    for (const name of ["inbox", "objects"])
      invariant(
        within(root, await realpath(path.join(this.root, name))),
        "unsafe_evidence_path",
        "Managed evidence directories must remain within the configured root",
      );
  }
  async importFromInbox(
    relative: string,
    kind: "log" | "screenshot" | "test_report" | "observation" | "other",
  ) {
    invariant(
      !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."),
      "unsafe_evidence_path",
      "Evidence must be a relative path within the configured inbox",
    );
    await this.initialize();
    const root = await realpath(this.root),
      inbox = await realpath(path.join(this.root, "inbox")),
      source = await realpath(path.resolve(inbox, relative));
    invariant(
      within(root, inbox) && within(inbox, source),
      "unsafe_evidence_path",
      "Evidence path escapes the inbox",
    );
    const info = await stat(source);
    invariant(
      info.isFile() && info.size <= this.maxBytes,
      "invalid_evidence_size",
      "Evidence must be a file within the size limit",
    );
    let data = await this.readBounded(source);
    if (
      kind === "log" ||
      kind === "observation" ||
      [".txt", ".log", ".json", ".xml", ".md", ".csv"].includes(
        path.extname(relative).toLowerCase(),
      )
    )
      data = Buffer.from(redact(data.toString("utf8"), this.patterns));
    const { content_hash, object_key } = await this.putManaged(data);
    return {
      kind,
      object_key,
      content_hash,
      size_bytes: data.length,
      availability: "available" as const,
      collected_at: now(),
    };
  }
  async putManaged(data: Buffer, expectedHash?: string) {
    invariant(
      data.length <= this.maxBytes,
      "invalid_evidence_size",
      "Evidence exceeds the size limit",
    );
    const content_hash = hash(data),
      object_key = `objects/${content_hash.slice(0, 2)}/${content_hash}`;
    invariant(
      !expectedHash || content_hash === expectedHash,
      "evidence_corrupt",
      "Imported evidence hash mismatch",
    );
    await this.initialize();
    const root = await realpath(this.root),
      objects = await realpath(path.join(this.root, "objects"));
    invariant(
      within(root, objects),
      "unsafe_evidence_path",
      "Evidence object directory escapes its root",
    );
    const parent = path.join(objects, content_hash.slice(0, 2));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const actualParent = await realpath(parent);
    invariant(
      within(root, actualParent),
      "unsafe_evidence_path",
      "Evidence object directory escapes its root",
    );
    const target = path.join(actualParent, content_hash);
    try {
      await writeFile(target, data, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const stored = await this.read(object_key);
    invariant(
      hash(stored) === content_hash,
      "evidence_corrupt",
      "Stored evidence hash mismatch",
    );
    return { content_hash, object_key };
  }
  async read(objectKey: string) {
    invariant(
      /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(objectKey),
      "unsafe_evidence_path",
      "Invalid managed evidence key",
    );
    const root = await realpath(this.root),
      target = await realpath(path.join(root, ...objectKey.split("/")));
    invariant(
      within(root, target),
      "unsafe_evidence_path",
      "Evidence object escapes its root",
    );
    const data = await this.readBounded(target);
    invariant(
      hash(data) === objectKey.split("/").at(-1),
      "evidence_corrupt",
      "Evidence object hash mismatch",
    );
    return data;
  }
  private async readBounded(filename: string) {
    const file = await open(filename, "r");
    try {
      return await readStableEvidenceFile(file, this.maxBytes);
    } finally {
      await file.close();
    }
  }
}
