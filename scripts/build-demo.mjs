// Статическая демоверсия для GitHub Pages: только фронтенд, вымышленные данные, без сервера и бота.
import {mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises';

const out = new URL('../dist/', import.meta.url), root = new URL('../', import.meta.url);
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});

for (const f of ['app.js', 'app.css', 'shared.mjs', 'icon.svg']) await copyFile(new URL(f, root), new URL(f, out));

let html = await readFile(new URL('index.html', root), 'utf8');
html = html
  .replace('<html lang="ru">', '<html lang="ru" data-static-demo>')
  .replaceAll(/(href|src)="\/(?!\/)/g, '$1="./')
  .replace('<title>Смена — мой рабочий день</title>', '<title>Смена — демоверсия</title>');
if (!html.includes('data-static-demo')) throw Error('index.html: не найден <html lang="ru">');
await writeFile(new URL('index.html', out), html);
await writeFile(new URL('.nojekyll', out), '');
console.log('dist/ готов');
