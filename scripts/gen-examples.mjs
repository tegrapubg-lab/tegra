// Генерирует examples/*.json из встроенных примеров (без секретов и ссылок на подключения).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const entry = path.resolve('scripts/.gen-examples.entry.ts');
fs.writeFileSync(entry, `
import fs from 'node:fs';
import { Engine } from '../src/engine/engine';
import { EXAMPLES, installExample } from '../src/engine/examples';
import { generateMasterKey } from '../src/engine/secrets';
const engine = new Engine({ dbPath: ':memory:', masterKey: generateMasterKey(), background: false });
fs.mkdirSync('examples', { recursive: true });
for (const ex of EXAMPLES) {
  const r = installExample(engine, ex.id);
  const data = engine.exportWorkflow(r.workflow.id);
  fs.writeFileSync('examples/' + ex.id + '.json', JSON.stringify(data, null, 2) + '\\n');
  console.log('examples/' + ex.id + '.json');
}
`);
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/tools/gen-examples.js', logLevel: 'error' });
fs.unlinkSync(entry);
const r = spawnSync(process.execPath, ['--no-warnings', 'dist/tools/gen-examples.js'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
