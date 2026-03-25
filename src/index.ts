import http from "node:http";
import { AdsAgent } from "./agent.js";
import { loadConfig, createHealthEndpoint } from "@domien-sev/agent-sdk";
import { initScheduler, stopScheduler } from "./scheduler.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  const config = loadConfig();
  const agent = new AdsAgent(config);

  const healthHandler = createHealthEndpoint(agent);

  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      return healthHandler(req, res);
    }

    if (req.url === "/message" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const message = JSON.parse(body);
        const response = await agent.handleMessage(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err, null, 2);
        console.error("Error handling message:", errMsg);
        if (err instanceof Error && err.stack) console.error(err.stack);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
      }
      return;
    }

    if (req.url === "/callbacks/task" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const taskResult = JSON.parse(body);
        console.log("Received task callback:", taskResult);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    // Manual trigger for optimization cycle (useful for testing)
    if (req.url === "/optimize" && req.method === "POST") {
      try {
        const { runOptimizationCycleHttp } = await import("./scheduler.js");
        const result = await runOptimizationCycleHttp(agent);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
      }
      return;
    }

    // Webhook endpoint for Shopify product create/update
    if (req.url === "/webhooks/shopify" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const product = JSON.parse(body);
        console.log("Shopify webhook received:", product.id);
        // Enqueue product sync — handled async
        res.writeHead(200);
        res.end("OK");
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const shutdown = async () => {
    stopScheduler();
    server.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(PORT, () => {
    console.log(`Ads agent listening on port ${PORT}`);
  });

  // Register with Directus (retry on failure)
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await agent.start();
      initScheduler(agent);
      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Directus registration attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);
      if (attempt === MAX_RETRIES) {
        console.error("Could not register with Directus — running without registration");
      } else {
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
