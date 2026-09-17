import http from "node:http";
import { createDatabase } from "./db.js";
import { createProductionApp } from "./production-app.js";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const database = createDatabase();
const app = createProductionApp({ db: database });
const server = http.createServer(app);

server.listen(port, host, () => {
  console.log(`AttenDesk production server listening on http://${host}:${port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} received, closing AttenDesk safely`);
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
