import { execSync } from 'child_process';
import fs from 'fs';

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';

// List tar contents
console.log('=== Tar Contents Check ===');
const listing = execSync(`tar -tzf "${tarPath}"`, { encoding: 'utf8', timeout: 30000 });
const lines = listing.trim().split('\n').filter(l => l.trim());
console.log('Total entries:', lines.length);

// Check for suspicious entries (file names that look like code)
const suspicious = lines.filter(l => {
  const fn = l.replace(/^\.\//, '').split('/').pop();
  return /[(]/.test(fn) || /[)]/.test(fn) || /console/.test(fn) || /log$/.test(fn);
});
console.log('\nSuspicious file names (contain parens/console/log):');
if (suspicious.length === 0) {
  console.log('  NONE OK');
} else {
  suspicious.forEach(l => console.log('  ' + l));
}

// Check for .env files (should only be .env.example/.env.template)
console.log('\n=== Sensitive File Check ===');
const envFiles = lines.filter(l => {
  const fn = l.replace(/^\.\//, '').split('/').pop();
  return fn.startsWith('.env') && !fn.includes('example') && !fn.includes('template');
});
console.log('.env files (should be 0):', envFiles.length === 0 ? 'NONE OK' : envFiles);

// Check for data directories
const dataEntries = lines.filter(l => l.includes('/data/') || l.includes('data-v'));
console.log('data entries (should be 0):', dataEntries.length === 0 ? 'NONE OK' : dataEntries.slice(0, 5));

// Check for node_modules
const nodeModEntries = lines.filter(l => l.includes('node_modules'));
console.log('node_modules entries (should be 0):', nodeModEntries.length === 0 ? 'NONE OK' : '(' + nodeModEntries.length + ')');

// Check version.txt content in package
const verEntry = lines.find(l => l.endsWith('version.txt'));
if (verEntry) {
  console.log('\nversion.txt entry:', verEntry);
  try {
    const verContent = execSync(`tar -xzf "${tarPath}" -O ${verEntry}`, { encoding: 'utf8', timeout: 10000 });
    console.log('version.txt content:', JSON.stringify(verContent.trim()));
  } catch (e) {
    console.log('Could not extract version.txt:', e.message.slice(0, 100));
  }
}

// Check BUILD-INFO
const buildEntry = lines.find(l => l.includes('BUILD-INFO'));
if (buildEntry) {
  console.log('BUILD-INFO entry:', buildEntry);
  try {
    const buildContent = execSync(`tar -xzf "${tarPath}" -O ${buildEntry}`, { encoding: 'utf8', timeout: 10000 });
    console.log('BUILD-INFO content:', buildContent.slice(0, 300));
  } catch (e) {
    console.log('Could not extract BUILD-INFO:', e.message.slice(0, 100));
  }
}
