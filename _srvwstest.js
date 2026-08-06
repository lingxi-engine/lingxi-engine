const WS = require('/opt/lingxi-engine/node_modules/ws');
const c = new WS('ws://localhost:3456/ws?id=srvtest01');
c.on('open', () => { console.log('SRV WS OPEN OK'); c.close(); });
c.on('error', e => { console.log('SRV WS ERROR ' + e.message); process.exit(1); });
c.on('close', (code, reason) => { console.log('SRV CLOSED ' + code + ' ' + (reason || '')); process.exit(code === 4001 ? 1 : 0); });
