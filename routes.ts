/**
 * Parsing the proxy routes a probe run should use.
 *
 * Kept apart from the probe scripts so the parsing can be tested without
 * launching browsers or touching the network - a mistyped route silently
 * becoming "direct" would quietly invalidate a whole run's conclusions.
 */
import type { ProxyLike, ProxyHop } from "./proxies";

export type Route = { label: string; proxy?: ProxyLike };

/**
 * Parse `label=url` entries, one per line or comma-separated.
 *
 * Hops within one route are separated by `>`. Blank lines and #comments are
 * ignored. An entry with no `label=` gets a positional name.
 */
export function parseRoutes(raw: string): Route[] {
  const routes: Route[] = [];

  for (const line of raw.split(/[\n,]/).map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;

    const split = line.indexOf("=");
    const label = split === -1 ? `proxy${routes.length + 1}` : line.slice(0, split).trim();
    const value = split === -1 ? line : line.slice(split + 1).trim();
    if (!value) continue;

    const hops: ProxyHop[] = value
      .split(">")
      .map((hop) => hop.trim())
      .filter(Boolean)
      .map((server) => ({ server }));
    if (hops.length === 0) continue;

    routes.push({ label, proxy: hops.length > 1 ? hops : hops[0].server });
  }

  return routes;
}

/** Every configured route, with the direct control first. */
export function withDirect(routes: Route[]): Route[] {
  return [{ label: "direct" }, ...routes];
}

/**
 * Narrow to the routes named by `--only=a,b`.
 *
 * Throws on a name that matches nothing: silently running every route because
 * of a typo wastes minutes and produces results attributed to the wrong exit.
 */
export function selectRoutes(routes: Route[], argv: string[]): Route[] {
  const flag = argv.find((a) => a.startsWith("--only="));
  if (!flag) return routes;

  const wanted = flag.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = routes.filter((r) => wanted.includes(r.label));
  if (chosen.length === 0) {
    throw new Error(
      `--only matched no routes. Available: ${routes.map((r) => r.label).join(", ")}`
    );
  }
  return chosen;
}

/** A printable route with any credentials removed. */
export function describeRoute(route: Route): string {
  if (!route.proxy) return "direct";
  const hops = Array.isArray(route.proxy) ? route.proxy : [route.proxy];
  return hops
    .map((hop) => (typeof hop === "string" ? hop : hop.server))
    .map((server) => server.replace(/\/\/[^@]*@/, "//***@"))
    .join(" -> ");
}
