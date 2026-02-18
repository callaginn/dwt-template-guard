import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "silent",
  plugins: [
    {
      name: "esbuild-problem-matcher",
      setup(build) {
        build.onStart(() => {
          console.log("[watch] build started");
        });
        build.onEnd((result) => {
          result.errors.forEach(({ text, location }) => {
            console.error(
              `✘ [ERROR] ${text}`,
              location
                ? `${location.file}:${location.line}:${location.column}:`
                : ""
            );
          });
          console.log("[watch] build finished");
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
} else {
  await esbuild.build(buildOptions);
}
