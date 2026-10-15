const fs = require('fs');
const p = 'C:/Users/Administrator/lingxi-engine/index.ts';
const c = fs.readFileSync(p, 'utf-8');

// Find exact match
const target = "app.use(express.static(join(process.cwd(), 'web')));";
const idx = c.indexOf(target);
console.log('Target length:', target.length);
console.log('Index:', idx);

if (idx >= 0) {
    const insertCode = `  // /m/ 移动端入口 -> 复用 /chat/ 界面 (响应式已适配)
  app.get('/m/', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'chat', 'index.html'));
  });
  app.get('/m', (_req, res) => {
    res.redirect('/m/');
  });

`;
    const newContent = c.slice(0, idx) + insertCode + c.slice(idx);
    fs.writeFileSync(p, newContent, 'utf-8');
    console.log('Done! Inserted at index:', idx);
} else {
    console.log('Target not found');
    // Try to find similar
    const idx2 = c.indexOf('express.static');
    if (idx2 >= 0) {
        console.log('Found express.static at:', idx2);
        console.log('Context:', c.substring(idx2-50, idx2+100));
    }
}