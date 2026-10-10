// Loopback HTTP transport for the controlled fixtures.
//
// One server carries three route kinds, all bound to 127.0.0.1 on an ephemeral
// port: exact JSON routes (npm registry metadata), exact byte routes (npm
// tarballs) and static file roots (the dumb-HTTP bare Git repository).
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export class LoopbackServer {
  #routes = new Map();
  #statics = [];
  #server = null;
  #origin = null;

  get origin() {
    if (!this.#origin) throw new Error("LoopbackServer is not started");
    return this.#origin;
  }

  get port() {
    return this.#server ? this.#server.address().port : null;
  }

  /** @param {(url: URL, req: import("node:http").IncomingMessage) => ({status?: number, type?: string, body: Buffer|string}|undefined)} handler */
  json(pathname, handler) {
    this.#routes.set(pathname, { type: "application/json", handler });
    return this;
  }

  bytes(pathname, handler) {
    this.#routes.set(pathname, { type: "application/octet-stream", handler });
    return this;
  }

  serveStatic(prefix, dir) {
    this.#statics.push({ prefix, dir: resolve(dir) });
    return this;
  }

  async start() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise((onListen, onError) => {
      this.#server.once("error", onError);
      this.#server.listen(0, "127.0.0.1", onListen);
    });
    this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
    return this.#origin;
  }

  #handle(req, res) {
    const url = new URL(req.url, this.origin ?? "http://127.0.0.1");
    const route = this.#routes.get(url.pathname);
    if (route) {
      const result = route.handler(url, req);
      if (result) {
        res.statusCode = result.status ?? 200;
        res.setHeader("Content-Type", result.type ?? route.type);
        res.end(result.body ?? "");
        return;
      }
    }
    const file = this.#resolveStatic(url.pathname);
    if (file) {
      res.statusCode = 200;
      res.end(readFileSync(file));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  #resolveStatic(pathname) {
    for (const entry of this.#statics) {
      if (!pathname.startsWith(entry.prefix)) continue;
      const relative = pathname.slice(entry.prefix.length).replace(/^\/+/, "");
      if (!relative) continue;
      const candidate = resolve(entry.dir, relative);
      // Refuse to serve anything that escapes the registered root.
      if (candidate !== entry.dir && !candidate.startsWith(`${entry.dir}/`)) {
        continue;
      }
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      // Directory requests are answered by git itself through index files.
      if (pathname.endsWith("/")) continue;
      return candidate;
    }
    return null;
  }

  async close() {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    this.#origin = null;
    await new Promise((done) => server.close(done));
    server.closeAllConnections?.();
  }
}
