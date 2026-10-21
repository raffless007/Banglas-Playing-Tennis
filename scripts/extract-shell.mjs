// Mechanical extraction: preserve every CSS rule and app statement, in order.
// The smaller document can reuse the browser's cached CSS and JavaScript.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../public/', import.meta.url);
let html = await readFile(new URL('index.html', root), 'utf8');
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1 || !styles.length) throw new Error('Expected the original inline app and styles; refusing to overwrite extracted files.');
await mkdir(new URL('css/', root), { recursive: true });
await writeFile(new URL('css/app.css', root), styles.map(match => match[1]).join('\n'));
await writeFile(new URL('js/app.js', root), scripts[0][1]);
let firstStyle = true;
html = html.replace(/<style>[\s\S]*?<\/style>/g, () => {
  if (!firstStyle) return '';
  firstStyle = false;
  return '<link rel="stylesheet" href="/css/app.css">\n  <link rel="stylesheet" href="/css/mobile-first.css">';
});
html = html.replace(scripts[0][0], '<script src="/js/app.js"></script>\n  <script src="/js/mobile-first.js"></script>');
await writeFile(new URL('index.html', root), html);
console.log(`Extracted ${styles.length} style blocks and the unchanged app script.`);
