import fs from 'fs';

const tsc = fs.readFileSync('/tmp/tsc-out.txt', 'utf8');
console.log('=== TSC OUTPUT ===');
console.log(tsc);

const test = fs.readFileSync('/tmp/test-out.txt', 'utf8');
console.log('\n=== TEST OUTPUT ===');
console.log(test);
