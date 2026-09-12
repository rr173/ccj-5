process.env.WS_PORT = '3790';
process.env.DB_FILE = './data/trashdbg.db';
const fs = require('fs');
for (const f of ['./data/trashdbg.db','./data/trashdbg.db-wal','./data/trashdbg.db-shm']) { try{fs.rmSync(f,{force:true})}catch{} }
const WebSocket = require('ws');
const serverMod = require('/workspace/server/index');
function connect(userName, userId) {
  const ws = new WebSocket('ws://127.0.0.1:3790/ws');
  const client = { ws, messages: [], waiters: [],
    send(o){ws.send(JSON.stringify(o));},
    next(f=()=>true,t=3000){return new Promise((res,rej)=>{const hit=this.messages.find(f);if(hit)return res(hit);const tm=setTimeout(()=>rej(new Error('timeout')),t);this.waiters.push({filter:f,resolve:res,reject:()=>{clearTimeout(tm);rej(new Error('timeout'));}});});},
    drain(f=()=>true){const out=this.messages.filter(f);this.messages=this.messages.filter(m=>!f(m));return out;} };
  ws.on('message', raw => { const msg=JSON.parse(raw.toString()); const w=client.waiters.find(x=>x.filter(msg)); if(w){client.waiters.splice(client.waiters.indexOf(w),1);w.resolve(msg);}else client.messages.push(msg); });
  return new Promise((res,rej)=>{ ws.on('open',()=>{client.send({type:'hello',userId,userName});client.next(m=>m.type==='hello').then(()=>client.next(m=>m.type==='snapshot').then(()=>res(client)));}); ws.on('error',rej); });
}
(async () => {
  await new Promise(r=>serverMod.server.listen(3790,r));
  const a = await connect('A','a1'), b = await connect('B','b1');
  await b.next(m=>m.type==='snapshot');
  const snap0 = a.messages.find(m=>m.type==='snapshot') ;
  const init = snap0;
  const parent = init.nodes.find(n=>n.content.includes('项目目标'));
  const child = init.nodes.find(n=>n.content.includes('实时看到'));
  console.log('treeRev', init.treeRev, parent.id, child.id);
  const pA = a.next(m=>m.type==='trash_update');
  const pB = b.next(m=>m.type==='trash_update');
  a.send({type:'delete',nodeId:parent.id,treeRev:init.treeRev});
  const uA = await pA, uB = await pB;
  console.log('trash_update A/B', uA.trash.length, uB.trash.length);
  const batch = uA.trash.find(t=>t.rootId===parent.id);
  const sNow = await new Promise(async (resolve)=>{
    const tmp = await connect('S','s1'); const s = tmp.messages.find(m=>m.type==='snapshot'); tmp.ws.close(); resolve(s);
  });
  console.log('snapshot treeRev now', sNow.treeRev, 'trash', sNow.trash.length);
  const pA2 = a.next(m=>m.type==='nodes_restored'||m.type==='restore_stale'||m.type==='tree_stale');
  const pB2 = b.next(m=>m.type==='nodes_restored'||m.type==='restore_stale'||m.type==='tree_stale');
  b.send({type:'restore',trashId:batch.id,treeRev:sNow.treeRev});
  const rA = await pA2, rB = await pB2;
  console.log('restore results:', rA.type, rB.type, rA.trashId || (rA.treeRev));
  process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
