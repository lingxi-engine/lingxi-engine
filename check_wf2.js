import fs from 'fs';
const c = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/js/app.js', 'utf8');
const lines = c.split('\n');
// Print lines 2620-2710 to see the workflow functions
for (let i = 2620; i <= 2710; i++) {
  console.log((i+1) + ': ' + lines[i]);
}
