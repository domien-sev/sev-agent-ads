import type http from "node:http";

export interface ApiRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse>;

export interface ApiResponse {
  status: number;
  data: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: ApiHandler;
}

export class ApiRouter {
  private routes: Route[] = [];

  get(path: string, handler: ApiHandler) {
    this.addRoute("GET", path, handler);
  }

  post(path: string, handler: ApiHandler) {
    this.addRoute("POST", path, handler);
  }

  patch(path: string, handler: ApiHandler) {
    this.addRoute("PATCH", path, handler);
  }

  private addRoute(method: string, path: string, handler: ApiHandler) {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  /** Try to match and handle a request. Returns null if no route matched. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const [pathname, queryString] = (req.url ?? "").split("?");
    const method = req.method ?? "GET";

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      const query: Record<string, string> = {};
      if (queryString) {
        for (const pair of queryString.split("&")) {
          const [k, v] = pair.split("=");
          query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
        }
      }

      let body: unknown = undefined;
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        const raw = await readBody(req);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }
        }
      }

      try {
        const result = await route.handler({ method, url: pathname, params, query, body });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.data));
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : (typeof err === "object" && err !== null ? JSON.stringify(err) : String(err));
        console.error(`API error [${method} ${pathname}]:`, message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return true;
    }

    return false;
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
