const fs = require('fs');

// Search in app.js
const appJs = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/js/app.js', 'utf8');
const appLines = appJs.split('\n');

console.log('=== app.js (js/) - goal/task/cron related lines ===');
for (let i = 0; i < appLines.length; i++) {
  const line = appLines[i];
  if (/goal|Goal|addGoal|removeGoal|loadGoals|setGoalStatus|rightTab|loadRight|renderGoal|renderTask|cron|Cron|loadCron|deleteCron|toggleCron|addCron|rightbar|right-body|task-card|goal-item|add-goal/i.test(line)) {
    console.log((i+1) + ': ' + line.substring(0, 200));
  }
}

// Search in root app.js
const appJs2 = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/app.js', 'utf8');
const appLines2 = appJs2.split('\n');

console.log('\n=== app.js (root) - goal/task/cron related lines ===');
for (let i = 0; i < appLines2.length; i++) {
  const line = appLines2[i];
  if (/goal|Goal|addGoal|removeGoal|loadGoals|setGoalStatus|rightTab|loadRight|renderGoal|renderTask|cron|Cron|loadCron|deleteCron|toggleCron|addCron|rightbar|right-body|task-card|goal-item|add-goal/i.test(line)) {
    console.log((i+1) + ': ' + line.substring(0, 200));
  }
}

// Search in index.html
const indexHtml = fs.readFileSync('C:/Users/Administrator/lingxi-engine/web/index.html', 'utf8');
const htmlLines = indexHtml.split('\n');

console.log('\n=== index.html - goal/task/cron/rightbar related lines ===');
for (let i = 0; i < htmlLines.length; i++) {
  const line = htmlLines[i];
  if (/goal|Goal|addGoal|removeGoal|loadGoals|setGoalStatus|rightTab|loadRight|renderGoal|renderTask|cron|Cron|loadCron|deleteCron|toggleCron|addCron|rightbar|right-body|right-head|task-card|goal-item|add-goal|outcome|Outcome/i.test(line)) {
    console.log((i+1) + ': ' + line.substring(0, 200));
  }
}
