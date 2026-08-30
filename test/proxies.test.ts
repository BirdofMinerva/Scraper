import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { resolveProxy, startProxyChain, proxyPool, describeProxy, withProxy } from "../proxies";

/** A CONNECT proxy that records what it was asked to reach. */
function testProxy(auth?: string) {
  const seen: string[] = [];
  const authFailures: number[] = [];
  const server = http.createServer((_q, r) => r.writeHead(400).end());
  server.on("connect", (req, client, head) => {
    if (auth && req.headers["proxy-authorization"] !== "Basic " + Buffer.from(auth).toString("base64")) {
      authFailures.push(1);
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    seen.push(req.url!);
    const [host, port] = req.url!.split(":");
    const up = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  return new Promise<{ url: string; seen: string[]; authFailures: number[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, authFailures, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

/** Plain TCP echo server, to stand in for a target host. */
function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  return new Promise<{ host: string; port: number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ host: "127.0.0.1", port, close: () => server.close() });
    });
  });
}

/** Speak CONNECT to a local proxy and return the tunnelled socket. */
function connectVia(proxyUrl: string, target: string) {
  const url = new URL(proxyUrl);
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      const status = Number(chunk.toString().split(" ")[1]);
      status === 200 ? resolve(socket) : reject(new Error(`proxy replied ${status}`));
    });
    socket.once("error", reject);
  });
}

describe("resolveProxy", () => {
  test("a URL string becomes a single native hop", async () => {
    const active = await resolveProxy("http://1.2.3.4:8080");
    assert.equal(active.proxy.server, "http://1.2.3.4:8080");
    assert.equal(active.hops.length, 1);
    await active.close();
  });

  test("credentials in the URL are lifted out for Playwright", async () => {
    const active = await resolveProxy("http://user:pass@1.2.3.4:8080");
    assert.equal(active.proxy.username, "user");
    assert.equal(active.proxy.password, "pass");
    await active.close();
  });

  test("a single hop needs no local listener", async () => {
    const active = await resolveProxy({ server: "socks5://1.2.3.4:1080" });
    assert.equal(active.proxy.server, "socks5://1.2.3.4:1080");
    assert.doesNotMatch(active.proxy.server, /127\.0\.0\.1/);
    await active.close();
  });

  test("a chain listens locally", async () => {
    const active = await resolveProxy([{ server: "http://1.2.3.4:8080" }, { server: "http://5.6.7.8:3128" }]);
    assert.match(active.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    await active.close();
  });

  test("an empty chain throws", async () => {
    await assert.rejects(() => resolveProxy([]), /empty/);
  });
});

describe("chaining", () => {
  test("traffic passes through every hop in order", async () => {
    const [hopA, hopB, target] = await Promise.all([testProxy(), testProxy(), echoServer()]);
    const chain = await startProxyChain([{ server: hopA.url }, { server: hopB.url }]);

    const socket = await connectVia(chain.proxy.server, `${target.host}:${target.port}`);
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString()));
      socket.write("ping");
    });

    assert.equal(echoed, "ping");
    assert.deepEqual(hopA.seen, [new URL(hopB.url).host]);   // A was told to reach B
    assert.deepEqual(hopB.seen, [`${target.host}:${target.port}`]); // B reached the target
    socket.destroy();
    await chain.close();
    [hopA, hopB, target].forEach((s) => s.close());
  });

  test("each hop's credentials authenticate the CONNECT to the next", async () => {
    const [hopA, hopB, target] = await Promise.all([testProxy("userA:passA"), testProxy(), echoServer()]);
    const chain = await startProxyChain([
      { server: hopA.url, username: "userA", password: "passA" },
      { server: hopB.url },
    ]);

    const socket = await connectVia(chain.proxy.server, `${target.host}:${target.port}`);
    assert.equal(hopA.authFailures.length, 0);
    assert.equal(hopB.seen.length, 1);
    socket.destroy();
    await chain.close();
    [hopA, hopB, target].forEach((s) => s.close());
  });

  test("a rejected hop fails the tunnel instead of leaking past it", async () => {
    const [hopA, hopB, target] = await Promise.all([testProxy("right:creds"), testProxy(), echoServer()]);
    const chain = await startProxyChain([
      { server: hopA.url, username: "wrong", password: "creds" },
      { server: hopB.url },
    ]);

    await assert.rejects(
      () => connectVia(chain.proxy.server, `${target.host}:${target.port}`),
      /replied 502/
    );
    assert.equal(hopB.seen.length, 0, "second hop never saw the target");
    await chain.close();
    [hopA, hopB, target].forEach((s) => s.close());
  });

  test("three hops chain as readily as two", async () => {
    const [a, b, c, target] = await Promise.all([testProxy(), testProxy(), testProxy(), echoServer()]);
    const chain = await startProxyChain([a, b, c].map((h) => ({ server: h.url })));
    const socket = await connectVia(chain.proxy.server, `${target.host}:${target.port}`);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    assert.deepEqual(c.seen, [`${target.host}:${target.port}`]);
    socket.destroy();
    await chain.close();
    [a, b, c, target].forEach((s) => s.close());
  });

  test("SOCKS inside a chain throws rather than routing around itself", async () => {
    const chain = await startProxyChain([
      { server: "socks5://1.2.3.4:1080" },
      { server: "http://5.6.7.8:3128" },
    ]);
    await assert.rejects(() => connectVia(chain.proxy.server, "example.com:443"), /replied 502/);
    await chain.close();
  });

  test("the listener is gone after close", async () => {
    const chain = await startProxyChain([{ server: "http://1.2.3.4:8080" }, { server: "http://5.6.7.8:3128" }]);
    const { port } = new URL(chain.proxy.server);
    await chain.close();
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const s = net.connect(Number(port), "127.0.0.1");
        s.once("connect", () => { s.destroy(); resolve(null); });
        s.once("error", reject);
      })
    );
  });
});

describe("helpers", () => {
  test("proxyPool round-robins in order", () => {
    const next = proxyPool(["a", "b", "c"]);
    assert.deepEqual([next(), next(), next(), next()], ["a", "b", "c", "a"]);
  });

  test("an empty pool throws", () => assert.throws(() => proxyPool([]), /empty/));

  test("describeProxy renders the route", () => {
    assert.equal(
      describeProxy([{ server: "http://1.2.3.4:8080" }, { server: "https://5.6.7.8:3128" }]),
      "1.2.3.4:8080 -> 5.6.7.8:3128"
    );
  });

  test("withProxy tears the chain down even when the body throws", async () => {
    let server = "";
    await assert.rejects(() =>
      withProxy([{ server: "http://1.2.3.4:8080" }, { server: "http://5.6.7.8:3128" }], async (active) => {
        server = active.proxy.server;
        throw new Error("boom");
      })
    , /boom/);
    const { port } = new URL(server);
    await assert.rejects(() => new Promise((resolve, reject) => {
      const s = net.connect(Number(port), "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(null); });
      s.once("error", reject);
    }));
  });
});
