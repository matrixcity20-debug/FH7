import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/server/index.js",
  packages: "external",
});

console.log("✓ Server built → dist/server/index.js");
