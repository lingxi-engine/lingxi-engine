import fs from 'fs';
const s = fs.readFileSync('index.ts', 'utf8').split(/\r?\n/);
const routes = [];
s.forEach((l, i) => {
  const m = l.match(/app\.(get|post|put|delete|patch)\(['"]([^'"]+)/);
  if (m) routes.push({ n: i + 1, method: m[1], path: m[2] });
});
console.log('total routes:', routes.length);
console.log('--- routes after L2300 ---');
routes.filter(r => r.n > 2300).forEach(r => console.log(r.n, r.method, r.path));
console.log('--- mesh & misc refs ---');
s.forEach((l, i) => {
  if (/mesh|Mesh/.test(l) && i > 2300) console.log((i + 1) + ': ' + l.trim().slice(0, 100));
});