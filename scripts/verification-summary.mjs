import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    environment: { type: "string" },
  },
});
if (!values.input || !values.output)
  throw new Error("Supply --input VITEST_JSON --output SUMMARY_JSON");
const raw = JSON.parse(await readFile(values.input, "utf8"));
const checks = raw.testResults.flatMap((suite) => {
  const normalized = suite.name.replaceAll("\\", "/");
  const file = normalized.slice(normalized.lastIndexOf("/tests/") + 1);
  if (!file.startsWith("tests/"))
    throw new Error("Unexpected test source path");
  return suite.assertionResults.map((test) => ({
    file,
    name: test.fullName,
    status: test.status,
    duration_ms: Math.round((test.duration ?? 0) * 100) / 100,
  }));
});
checks.forEach((check, index) => {
  check.check_id = `T${String(index + 1).padStart(3, "0")}`;
});
const result = {
  schema_version: 1,
  started_at: new Date(raw.startTime).toISOString(),
  test_files: raw.testResults.length,
  total: raw.numTotalTests,
  passed: raw.numPassedTests,
  failed: raw.numFailedTests,
  skipped_or_pending: raw.numPendingTests,
  reporter_success: raw.success,
  ...(values.environment
    ? { environment: JSON.parse(await readFile(values.environment, "utf8")) }
    : {}),
  limitation:
    "Sanitized assertion results only. Reporter success alone does not prove process exit 0 or absence of native/unhandled errors; consult the dated delivery record and command outcome. No raw logs, failure bodies or absolute source paths included.",
  checks,
};
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
process.stdout.write(
  JSON.stringify({
    files: result.test_files,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    pending: result.skipped_or_pending,
  }) + "\n",
);
