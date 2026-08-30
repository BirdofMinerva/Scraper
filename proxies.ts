/**
 * Proxy support, including multi-hop chains.
 *
 * Playwright takes exactly one upstream proxy per browser, so a chain is built
 * by running a small local proxy that the browser talks to, which forwards
 * through each hop in turn: browser -> 127.0.0.1 -> hop1 -> hop2 -> target.
 * Only the last hop's IP reaches the target, and no hop sees both the browser
 * and the destination.
 */
import net from "node:net";
import { ProxyError } from "./errors";
import tls from "node:tls";
import http from "node:http";
import { URL } from "node:url";

export type ProxyHop = {
  /** `http://host:port`, `https://host:port`, or `socks5://host:port`. */
  server: string;
  username?: string;
  password?: string;
};

/** A single proxy, or an ordered chain from the browser outwards. */
export type ProxyLike = string | ProxyHop | ProxyHop[];

/** What Playwright wants in `launchOptions.proxy`. */
export type PlaywrightProxy = {
  server: string;
  username?: string;
  password?: string;
};

export type ActiveProxy = {
  /** Pass this to `launchProfile(profile, { proxy })`. */
  proxy: PlaywrightProxy;
  /** The hops behind it, for logging. */
  hops: ProxyHop[];
  /** Shuts down the local listener, if this chain needed one. */
  close: () => Promise<void>;
};

const asHops = (proxy: ProxyLike): ProxyHop[] =>
  typeof proxy === "string"
    ? [{ server: proxy }]
    : Array.isArray(proxy)
      ? proxy
      : [proxy];

function parseHop(hop: ProxyHop) {
  const url = new URL(hop.server);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 8080)),
    tls: url.protocol === "https:",
    socks: url.protocol.startsWith("socks"),
    username: hop.username ?? (url.username || undefined),
    password: hop.password ?? (url.password || undefined),
  };
}

const authHeader = (username?: string, password?: string) =>
  username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}\r\n`
    : "";

/** Send one CONNECT over an established socket and wait for the 200. */
function connectThrough(
  socket: net.Socket,
  target: string,
  username?: string,
  password?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;

      socket.removeListener("data", onData);
      socket.removeListener("error", reject);
      const status = Number(buffer.slice(0, buffer.indexOf("\r\n")).split(" ")[1]);
      if (status >= 200 && status < 300) {
        // Anything after the headers belongs to the tunnel.
        const rest = Buffer.from(buffer.slice(end + 4), "latin1");
        if (rest.length) socket.unshift(rest);
        resolve();
      } else {
        reject(new ProxyError(`CONNECT ${target} rejected with ${status}`));
      }
    };

    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        authHeader(username, password) +
        "Proxy-Connection: Keep-Alive\r\n\r\n"
    );
  });
}

/**
 * Open a tunnel to `target` through every hop in order.
 *
 * Each CONNECT is addressed to the *next* hop but authenticated with the
 * credentials of the hop currently being spoken to - that offset is the part
 * that is easy to get wrong.
 */
async function dialChain(hops: ProxyHop[], target: string): Promise<net.Socket> {
  const parsed = hops.map(parseHop);
  const socks = parsed.findIndex((hop) => hop.socks);
  if (socks !== -1) {
    throw new ProxyError(
      `hop ${socks + 1} is SOCKS; chains are HTTP CONNECT only. ` +
        "Use a single SOCKS proxy on its own, which Playwright supports natively."
    );
  }

  const first = parsed[0];
  let socket: net.Socket = await new Promise((resolve, reject) => {
    const s = net.connect(first.port, first.host);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  if (first.tls) {
    socket = tls.connect({ socket, servername: first.host });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve).once("error", reject);
    });
  }

  for (let i = 1; i < parsed.length; i++) {
    const speakingTo = parsed[i - 1];
    const next = parsed[i];
    await connectThrough(
      socket,
      `${next.host}:${next.port}`,
      speakingTo.username,
      speakingTo.password
    );
    if (next.tls) {
      socket = tls.connect({ socket, servername: next.host });
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve).once("error", reject);
      });
    }
  }

  const last = parsed[parsed.length - 1];
  await connectThrough(socket, target, last.username, last.password);
  return socket;
}

/**
 * Start a local proxy that forwards through the chain.
 *
 * Returns immediately with the address to hand Playwright. Call `close()` when
 * the browser is done with it - `runMission` does this for you.
 */
export async function startProxyChain(
  hops: ProxyHop[],
  options: { verbose?: boolean } = {}
): Promise<ActiveProxy> {
  const { verbose = false } = options;
  const server = http.createServer();

  // HTTPS and everything else the browser tunnels.
  server.on("connect", async (req, clientSocket, head) => {
    try {
      const upstream = await dialChain(hops, req.url ?? "");
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const drop = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.once("error", drop);
      clientSocket.once("error", drop);
    } catch (error) {
      // No body: anything after the status line would be read as tunnel data,
      // and the browser would treat the failure as a download.
      if (verbose) console.error(`[proxy-chain] ${(error as Error).message}`);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });

  // Plain http:// goes through the same chain, then straight down the tunnel.
  server.on("request", async (req, res) => {
    let upstream: net.Socket | undefined;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const port = url.port || "80";
      upstream = await dialChain(hops, `${url.hostname}:${port}`);

      const headers = Object.entries(req.headers)
        .filter(([key]) => !key.startsWith("proxy-"))
        .map(([key, value]) => `${key}: ${[value].flat().join(", ")}\r\n`)
        .join("");
      upstream.write(
        `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n`
      );

      req.pipe(upstream);
      upstream.pipe(res.socket!);
      res.socket!.once("close", () => upstream?.destroy());
    } catch (error) {
      upstream?.destroy();
      res.writeHead(502).end((error as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    proxy: { server: `http://127.0.0.1:${port}` },
    hops,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Turn any proxy shape into something launchable.
 *
 * A single hop is handed straight to Playwright (so SOCKS works, and no local
 * listener is needed); two or more start a chain.
 */
export async function resolveProxy(proxy: ProxyLike): Promise<ActiveProxy> {
  const hops = asHops(proxy);
  if (hops.length === 0) throw new ProxyError("proxy chain is empty");

  if (hops.length === 1) {
    const [hop] = hops;
    const parsed = parseHop(hop);
    return {
      proxy: {
        server: hop.server,
        ...(parsed.username ? { username: parsed.username } : {}),
        ...(parsed.password ? { password: parsed.password } : {}),
      },
      hops,
      close: async () => {},
    };
  }

  return startProxyChain(hops);
}

/** Round-robin over a list of proxies or chains, in order. */
export function proxyPool(proxies: ProxyLike[]): () => ProxyLike {
  if (proxies.length === 0) throw new ProxyError("proxy pool is empty");
  let index = 0;
  return () => proxies[index++ % proxies.length];
}

/** Run something with a proxy up, and always tear it down afterwards. */
export async function withProxy<T>(
  proxy: ProxyLike,
  fn: (active: ActiveProxy) => Promise<T>
): Promise<T> {
  const active = await resolveProxy(proxy);
  try {
    return await fn(active);
  } finally {
    await active.close();
  }
}

/** Human-readable chain, e.g. "1.2.3.4:8080 -> 5.6.7.8:3128". */
export function describeProxy(hops: ProxyHop[]): string {
  return hops
    .map((hop) => {
      const { host, port } = parseHop(hop);
      return `${host}:${port}`;
    })
    .join(" -> ");
}
