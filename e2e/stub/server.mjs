// The e2e stub app. GET /healthz answers {version, database} (503 when STUB_HEALTH is
// unready), GET /ping answers pong. `node server.mjs worker` only stays alive.
import http from "node:http";
import { migrate } from "./migrate.mjs";

const version = process.env.STUB_VERSION ?? "0.0.0";
const health = process.env.STUB_HEALTH ?? "ok";

if (health === "crash") {
  console.error(`stub ${version}: crashing on purpose`);
  setTimeout(() => process.exit(1), 300);
} else if (process.argv[2] === "worker") {
  console.log(`stub ${version}: worker running`);
  const timer = setInterval(() => undefined, 60_000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
} else {
  if (process.env.STUB_MIGRATE_ON_START === "1") {
    migrate();
  }
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      if (health === "unready") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "starting" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: health === "wrong-version" ? "0.0.1" : version,
          database: "ok",
        }),
      );
      return;
    }
    if (request.url === "/ping") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pong");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(3000, () => console.log(`stub ${version}: listening on 3000 (${health})`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
