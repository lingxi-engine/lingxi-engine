const fs = require('fs');
const p = 'C:/Users/Administrator/lingxi-engine/mobile-app/app/src/main/java/com/lingxi/engine/MainActivity.java';
const c = fs.readFileSync(p, 'utf-8');
const lines = c.split('\n');
console.log('Total lines:', lines.length);
console.log('Line 59 before:', lines[58]);

const newLine = '    private static final String DEFAULT_ENDPOINT = "http://10.0.2.2:3456"; // Android模拟器访问宿主机localhost，真机请改为电脑局域网IP';
lines[58] = newLine;

const newContent = lines.join('\n');
fs.writeFileSync(p, newContent, 'utf-8');

const c2 = fs.readFileSync(p, 'utf-8');
const lines2 = c2.split('\n');
console.log('Line 59 after:', lines2[58]);