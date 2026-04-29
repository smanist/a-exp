import http from "node:http";
import { URL } from "node:url";

import type { UnifiedStatus } from "../status.js";

export type ApiServerOpts = {
  getStatus: () => Promise<UnifiedStatus>;
  host?: string;
  port?: number;
};

let server: http.Server | null = null;
let listeningPort: number | null = null;

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function startApiServer(opts: ApiServerOpts): Promise<number> {
  if (server && listeningPort != null) return listeningPort;

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8420;

  server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, await opts.getStatus());
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, host, () => resolve());
  });
  listeningPort = port;
  return port;
}

export async function stopApiServer(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  listeningPort = null;
  await new Promise<void>((resolve, reject) => {
    current.close((err) => (err ? reject(err) : resolve()));
  });
}
