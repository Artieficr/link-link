import esbuild from 'esbuild';
import process from 'process';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

// Resolve onnxruntime-web through @xenova/transformers so pnpm's virtual
// store doesn't hide it. onnxruntime-web is a direct dep of @xenova/transformers
// so it's always reachable from there.
const require = createRequire(import.meta.url);
const txRequire = createRequire(require.resolve('@xenova/transformers'));
const onnxWebPath = path.dirname(txRequire.resolve('onnxruntime-web/package.json'));

const prod = process.argv[2] === 'production';

// In Obsidian's Electron renderer process.release.name === 'node', so
// @xenova/transformers selects the onnxruntime-node backend. But
// onnxruntime-node requires native bindings that can't be bundled, so we
// alias it to onnxruntime-web (the WASM backend). The WASM binaries
// themselves are NOT bundled — they are fetched from CDN at runtime.
//
// onnxruntime-web's pre-built bundle contains a Node.js code path that calls
// require('fs') and require('path'). In Electron's renderer those calls would
// succeed and give the ONNX runtime real filesystem access — which we don't
// want and never need (models are fetched from CDN). This plugin intercepts
// those two requires and returns empty stubs so the fs code path becomes a
// no-op, while WASM/fetch loading continues to work normally.
//
// 'sharp' is also stubbed here: @xenova/transformers only imports it for its
// image-embedding pipeline, which this plugin never calls (text embeddings
// only) — its own package.json already marks "sharp": false in its "browser"
// field for exactly this reason. esbuild's built-in browser-field handling
// works for that when sharp ships a legacy "main"-only package.json, but not
// once sharp publishes a modern conditional "exports" map (as newer versions
// do) — the built-in disabled-module stub doesn't satisfy `import sharp from
// 'sharp'`'s expected default export in that shape. Intercepting it here
// ourselves, the same way as fs/path above, sidesteps that mismatch entirely.
const stubNodeModulesPlugin = {
  name: 'stub-node-modules',
  setup(build) {
    build.onResolve({ filter: /^(fs|path|sharp)$/ }, args => ({
      path: args.path,
      namespace: 'stub-node-modules',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-node-modules' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

// onnxruntime-web's minified bundle also embeds its threaded-WASM worker
// bootstrap script as a plain string (so it can spin up a Worker without a
// separate file), which contains its own literal require("fs") and
// require("worker_threads") calls. Being string contents rather than a real
// import/require, esbuild's module resolution — and so stubNodeModulesPlugin
// above — never sees these, and they survive verbatim into the output.
// This worker is only ever created when the ONNX threaded backend is armed,
// which requires numThreads > 1; indexing.ts hardcodes numThreads = 1 (not
// user-configurable), so that code path can never run. Blank out the two
// call sites post-build so no literal Node filesystem/threading require
// remains in the shipped bundle. If numThreads is ever raised above 1, this
// must be revisited — the threaded worker would need the real requires back.
const outfile = 'main.js';

esbuild.build({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'node:buffer', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile,
  write: false,
  plugins: [stubNodeModulesPlugin],
  alias: {
    'onnxruntime-node': onnxWebPath,
  },
}).then(result => {
  for (const file of result.outputFiles) {
    let contents = file.text;
    if (file.path.endsWith(outfile)) {
      contents = contents
        .split('require("fs")').join('{}')
        .split('require("worker_threads")').join('{}');
    }
    fs.writeFileSync(file.path, contents);
  }
}).catch(() => process.exit(1));
