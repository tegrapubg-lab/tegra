// Сборка engine и main/preload в CJS-бандлы (esbuild). Renderer собирает vite.
import { build } from 'esbuild';
const what = process.argv[2] ?? 'all';
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: true, logLevel: 'info' };
if (what === 'engine' || what === 'all') {
  await build({ ...common, entryPoints: ['src/engine/main.ts'], outfile: 'dist/engine/main.js' });
}
if (what === 'main' || what === 'all') {
  await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', external: ['electron'] });
  await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', external: ['electron'] });
}
