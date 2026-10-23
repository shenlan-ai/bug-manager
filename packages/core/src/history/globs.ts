import { minimatch } from "minimatch";

export const matchesHistoryGlob = (value: string, pattern: string) =>
  minimatch(value, pattern, {
    dot: true,
    nocase: process.platform === "win32",
  });
