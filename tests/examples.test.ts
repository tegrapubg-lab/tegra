import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasErrors, validateWorkflow } from '../src/shared/validate';
import { makeEngine } from './helpers';

describe('файлы примеров examples/*.json', () => {
  const dir = path.resolve(__dirname, '../examples');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  it('есть примеры', () => expect(files.length).toBeGreaterThanOrEqual(5));
  for (const f of files) {
    it(`${f}: импортируется, не содержит секретов и ссылок на подключения`, () => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(raw).not.toMatch(/\d{6,}:[\w-]{30,}/); // токены ботов
      const { engine } = makeEngine();
      const wf = engine.importWorkflow(JSON.parse(raw));
      expect(wf.nodes.length).toBeGreaterThan(1);
      for (const n of wf.nodes) expect(n.params.credential ?? n.params.secret ?? n.params.auth).toBeFalsy();
      // единственные допустимые ошибки — «выберите подключение»
      const errs = validateWorkflow(wf).filter((i) => i.level === 'error');
      expect(hasErrors(errs) ? errs.every((e) => /Бот Telegram|Провайдер ИИ|Секрет|обязательно/i.test(e.message)) : true).toBe(true);
    });
  }
});
