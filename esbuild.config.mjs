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
// Plain 'fs'/'path' inside @xenova/transformers are NOT externalized so
// esbuild stubs them as empty objects (platform:browser default), keeping
// RUNNING_LOCALLY=false and preventing the url.fileURLToPath crash that
// occurs in Electron's renderer when import.meta.url is an app:// URL.
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
  alias: {
    'onnxruntime-node': onnxWebPath,
  },
}).catch(() => process.exit(1));
