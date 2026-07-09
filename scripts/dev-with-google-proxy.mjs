#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";

const proxyHost = "127.0.0.1";
const proxyPort = 8791;
const proxyPath = "/google-fetch";
const proxyUrl = `http://${proxyHost}:${proxyPort}${proxyPath}`;
const upstreamProxy = process.env.OEM_DEV_UPSTREAM_PROXY || "http://127.0.0.1:7897";
const allowedHosts = new Set(["oauth2.googleapis.com", "translation.googleapis.com"]);

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function startGoogleFetchProxy() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== proxyPath) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(raw || "{}");
        const url = new URL(String(payload.url || ""));
        if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
          throw new Error("blocked upstream");
        }

        const method = String(payload.method || "GET").toUpperCase();
        const headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
        const args = ["-sS", "--connect-timeout", "10", "--max-time", "30", "-X", method];

        for (const [name, value] of Object.entries(headers)) {
          const lower = name.toLowerCase();
          if (lower === "host" || lower === "content-length") continue;
          args.push("-H", `${name}: ${value}`);
        }

        if (typeof payload.body === "string") {
          args.push("--data-binary", payload.body);
        }

        args.push(String(url), "-w", "\n__STATUS__:%{http_code}");
        const child = spawn("curl", args, {
          env: {
            ...process.env,
            HTTP_PROXY: upstreamProxy,
            HTTPS_PROXY: upstreamProxy,
          },
        });

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => {
          const marker = stdout.match(/\n__STATUS__:(\d{3})\s*$/);
          const status = marker ? Number(marker[1]) : 502;
          const body = marker ? stdout.slice(0, marker.index) : stdout;
          if (code !== 0 && !body) {
            sendJson(res, 502, { status: 502, body: stderr || `curl exited ${code}` });
            return;
          }
          sendJson(res, 200, {
            status,
            headers: { "content-type": "application/json" },
            body,
          });
        });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, proxyHost, () => {
      server.off("error", reject);
      console.log(`[dev] Google fetch proxy listening on ${proxyUrl}`);
      console.log(`[dev] Google fetch proxy upstream: ${upstreamProxy}`);
      resolve(server);
    });
  });
}

function startWrangler() {
  const extraArgs = process.argv.slice(2);
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--port",
      "8787",
      "--ip",
      "127.0.0.1",
      "--enable-containers=false",
      ...extraArgs,
    ],
    {
      stdio: "inherit",
      env: process.env,
    }
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  return child;
}

try {
  const server = await startGoogleFetchProxy();
  const wrangler = startWrangler();

  const shutdown = () => {
    wrangler.kill("SIGINT");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    console.error(`[dev] ${proxyUrl} is already in use. Stop the old proxy or change scripts/dev-with-google-proxy.mjs.`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
