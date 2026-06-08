import esbuild from 'esbuild';
import process from 'process';
import path from 'path';
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
const stubNodeModulesPlugin = {
  name: 'stub-node-modules',
  setup(build) {
    build.onResolve({ filter: /^(fs|path)$/ }, args => ({
      path: args.path,
      namespace: 'stub-node-modules',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-node-modules' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

esbuild.build({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'node:buffer'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  plugins: [stubNodeModulesPlugin],
  alias: {
    'onnxruntime-node': onnxWebPath,
  },
}).catch(() => process.exit(1));
