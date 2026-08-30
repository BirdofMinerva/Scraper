import { defineConfig } from "tsup";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Build the publishable library into dist/. The dev workflow is unaffected:
 * tests, the dashboard and the CLIs keep running via tsx against the SOURCE.
 *
 * Because package.json stays `type: "commonjs"` (so the CLI entrypoints keep
 * their `require.main`/`__dirname` under tsx), tsup names the outputs
 * dist/index.js (CJS) and dist/index.mjs (ESM). The exports map routes
 * import → .mjs and require → .js, so the filenames are invisible to consumers.
 *
 * Playwright and the stealth plugins are heavy, native-ish runtime deps — they
 * are left external (peer/runtime), never bundled into dist.
 *
 * node:sqlite quirk: esbuild normalises `node:x` → `x` on external imports, but
 * unlike the older builtins `node:sqlite` is NOT resolvable under the bare name
 * "sqlite" (Node only exposes it with the prefix). esbuild offers no opt-out,
 * so a post-build pass restores the prefix. The `"sqlite"` string appears only
 * as the module specifier (other mentions are `sqliteStore` / `sqlite:` backtick
 * templates), so the rewrite is unambiguous.
 */
async function restoreNodeSqlitePrefix(outDir: string) {
  for (const file of ["index.js", "index.mjs"]) {
    const p = path.join(outDir, file);
    const src = await readFile(p, "utf8");
    const fixed = src
      .replaceAll('require("sqlite")', 'require("node:sqlite")')
      .replaceAll('from "sqlite"', 'from "node:sqlite"');
    if (fixed !== src) await writeFile(p, fixed);
  }
}

export default defineConfig({
  entry: ["index.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  target: "node22",
  sourcemap: true,
  clean: true,
  external: ["playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],
  async onSuccess() {
    await restoreNodeSqlitePrefix("dist");
  },
});
