const fs = require('fs');
const src = fs.readFileSync('src/core/usage-tracker.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 57; i < 70; i++) {
  console.log((i+1) + ': ' + JSON.stringify(lines[i]));
}
