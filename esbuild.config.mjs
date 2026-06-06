import esbuild from 'esbuild';
import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const prod = process.argv[2] === 'production';

// 'node:*' externals stay as require('node:fs') etc. in the bundle, so Electron
// provides the real modules at runtime. We deliberately do NOT external the un-
// prefixed 'fs'/'path' — @xenova/transformers imports those and esbuild stubs
// them as empty objects (platform:browser default), keeping RUNNING_LOCALLY=false
// and preventing the url.fileURLToPath(import.meta.url) crash that occurs in
// Electron's renderer when import.meta.url evaluates to an app:// URL.
esbuild.build({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'node:fs', 'node:path', 'node:buffer'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  // In Obsidian's Electron renderer process.release.name === 'node', so
  // @xenova/transformers/src/backends/onnx.js selects ONNX_NODE. But
  // onnxruntime-node requires native bindings that can't be bundled, so
  // esbuild stubs it as an empty object, leaving env.backends.onnx undefined.
  // Alias it to onnxruntime-web so the bundled wasm backend is used instead.
  // In Obsidian's Electron renderer process.release.name === 'node', so
  // @xenova/transformers/src/backends/onnx.js selects ONNX_NODE. But
  // onnxruntime-node requires native bindings that can't be bundled, so
  // esbuild stubs it as an empty object, leaving env.backends.onnx undefined.
  // Alias it to onnxruntime-web's package dir so the bundled wasm backend is
  // used instead. onnxruntime-web is a transitive dep under @xenova/transformers.
  alias: {
    'onnxruntime-node': path.resolve(
      __dirname,
      'node_modules/.pnpm/onnxruntime-web@1.14.0/node_modules/onnxruntime-web'
    ),
  },
}).catch(() => process.exit(1));
