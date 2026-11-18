/**
 * Entry point: reads the settings, starts the server and stops it cleanly on SIGTERM / SIGINT.
 * Rooms live in memory, so a restart ends every room; pages reconnect and, finding their room
 * gone, say so.
 */
import { createServerApp } from "./app";
import { loadConfig } from "./config";

const { config, problems } = loadConfig(process.env);
if (problems.length) {
  console.error("TetriZZ server: settings are not valid:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

let app: Awaited<ReturnType<typeof createServerApp>>;
try {
  app = await createServerApp(config, { version: __APP_VERSION__ });
} catch (error) {
  // The database address can hold a password, so only the message of the error is printed.
  console.error("TetriZZ server: could not start:", error instanceof Error ? error.message : error);
  process.exit(1);
}
const log = app.fastify.log;

try {
  const port = await app.listen();
  log.info(
    {
      version: __APP_VERSION__,
      node: process.version,
      host: config.host,
      port,
      seatGraceSeconds: config.seatGraceMs / 1000,
      database:
        config.database.driver === "sqlite"
          ? { driver: "sqlite", path: config.database.path }
          : { driver: config.database.driver },
      allowedOrigins: [...config.origins.allowed],
      sameOrigin: config.origins.allowSameOrigin,
      fileOrigin: config.origins.allowFile,
    },
    "TetriZZ server listening",
  );
} catch (error) {
  log.error({ err: error }, "could not start");
  process.exit(1);
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "stopping");
  try {
    await app.shutdown();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "stop failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled rejection");
  process.exit(1);
});
