const fs = require('fs');

// Read the rightbar section from index.html (around lines 676-730)
const html = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/index.html', 'utf8');
const htmlLines = html.split('\n');

console.log('=== index.html lines 676-730 (rightbar) ===');
for (let i = 675; i < 730 && i < htmlLines.length; i++) {
  console.log((i+1) + ': ' + htmlLines[i]);
}

console.log('\n=== index.html lines 745-760 (switchTab function) ===');
for (let i = 744; i < 760 && i < htmlLines.length; i++) {
  console.log((i+1) + ': ' + htmlLines[i]);
}

// Read addRightGoal and deleteGoal from web/js/app.js
const appJs = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/js/app.js', 'utf8');
const appLines = appJs.split('\n');

console.log('\n=== web/js/app.js lines 3475-3510 (addRightGoal, deleteGoal) ===');
for (let i = 3474; i < 3510 && i < appLines.length; i++) {
  console.log((i+1) + ': ' + appLines[i]);
}

console.log('\n=== web/js/app.js lines 2870-2935 (loadGoals, addGoal, etc) ===');
for (let i = 2869; i < 2935 && i < appLines.length; i++) {
  console.log((i+1) + ': ' + appLines[i]);
}

console.log('\n=== web/js/app.js lines 2945-2995 (adminCron, addCron, removeCron) ===');
for (let i = 2944; i < 2995 && i < appLines.length; i++) {
  console.log((i+1) + ': ' + appLines[i]);
}

// Also check what's at line 681 area - taskMonitorList
console.log('\n=== index.html lines 676-700 (task cards detail) ===');
for (let i = 675; i < 700 && i < htmlLines.length; i++) {
  console.log((i+1) + ': ' + htmlLines[i]);
}
