import fs from 'fs';
const c = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/js/app.js', 'utf8');
const lines = c.split('\n');
console.log('Total lines:', lines.length);
const wfLines = [];
lines.forEach((l, i) => {
  if (l.includes('wfRun') || l.includes('wfSaveToCloud') || l.includes('wfLoadFromCloud') || l.includes('wfCurrentId') || l.includes('wfLastSavedId') || l.includes('function wf')) {
    wfLines.push((i+1) + ': ' + l.trim());
  }
});
console.log('Workflow related lines:');
wfLines.forEach(l => console.log(l));
