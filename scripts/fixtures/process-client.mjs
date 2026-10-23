import {
  openStore,
  Taxonomy,
  Jobs,
  HistoryIngestion,
  Analysis,
  errorResponse,
} from "../../packages/core/dist/index.js";

const store = await openStore(
  JSON.parse(process.env.BUG_MANAGER_CHILD_DATABASE),
);
try {
  const [operation, input, mutation] = process.argv.slice(2);
  const payload = JSON.parse(input),
    meta = JSON.parse(mutation);
  let data;
  if (operation === "propose")
    data = await new Taxonomy(store).propose(payload, meta);
  else if (operation === "claim")
    data = await new Jobs(store).claim(payload, meta);
  else if (operation === "complete")
    data = await new Jobs(store).complete(payload, meta);
  else if (operation === "sync")
    data = await new HistoryIngestion(
      store,
      JSON.parse(process.env.BUG_MANAGER_CHILD_CONFIG),
    ).resume(payload, meta);
  else if (operation === "analysis_claim")
    data = await new Analysis(
      store,
      JSON.parse(process.env.BUG_MANAGER_CHILD_CONFIG),
    ).claim(payload, meta);
  else if (operation === "analysis_submit")
    data = await new Analysis(
      store,
      JSON.parse(process.env.BUG_MANAGER_CHILD_CONFIG),
    ).submit(payload, meta);
  else throw new Error("Unknown test operation");
  process.stdout.write(JSON.stringify({ data }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: errorResponse(error) }));
  process.exitCode = 1;
} finally {
  await store.close();
}
