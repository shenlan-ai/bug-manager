import { Application, openStore } from "../../packages/core/dist/index.js";
import { runHistoryWorker } from "../../packages/worker/dist/index.js";

const config = JSON.parse(process.env.BUG_MANAGER_CHILD_CONFIG);
const store = await openStore(config.database),
  controller = new AbortController();
process.stdin.on("data", () => controller.abort());
try {
  await runHistoryWorker(new Application(store, config), controller.signal, {
    watch: false,
    interval_ms: Number(process.argv[2]),
    on_scan: (result) => process.stdout.write(JSON.stringify(result) + "\n"),
  });
} finally {
  await store.close();
  process.stdin.destroy();
}
