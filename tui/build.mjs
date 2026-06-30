import * as esbuild from 'esbuild';

// Transpile JSX and inline our own local modules, but keep node_modules
// (react, ink, ink-text-input) external so Node loads them as native ESM.
// Bundling Ink's internals into one file breaks: it has top-level await
// and CJS deps that fail under a single esm/cjs output format.
await esbuild.build({
  entryPoints: ['app.js'],
  outfile: 'dist/app.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  loader: { '.js': 'jsx' },
});

console.log('Built dist/app.mjs');
