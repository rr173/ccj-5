process.env.WS_PORT='3800'; process.env.WS_PING_MS='60000'; process.env.DB_FILE='/tmp/dbg9.db'; process.env.LOCK_TTL_MS='30000';
const fs=require('fs'),crypto=require('crypto');
for(const f of ['/tmp/dbg9.db','/tmp/dbg9.db-wal','/tmp/dbg9.db-shm']) {try{fs.rmSync(f,{force:true})}catch{}}
const {JSDOM}=require('jsdom'); const WS=require('ws'); const serverMod=require('./server/index');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function user(name,uid){
  const html=fs.readFileSync('./public/index.html','utf8'), appJs=fs.readFileSync('./public/app.js','utf8');
  const dom=new JSDOM(html,{url:'http://127.0.0.1:3800/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom;
  const socks=[]; const recv=[];
  function WrappedWS(url,proto){ const ws=proto?new WS(url,proto):new WS(url); socks.push(ws);
    ws.on('message',raw=>{ try{const m=JSON.parse(raw.toString()); recv.push(m.type+':'+(m.nodeId||'')+(m.reason?(':'+m.reason):''));}catch{} });
    return ws; }
  WrappedWS.prototype=WS.prototype; WrappedWS.OPEN=WS.OPEN;
  window.WebSocket=WrappedWS;
  Object.defineProperty(window,'crypto',{value:crypto.webcrypto,configurable:true,writable:true});
  window.requestAnimationFrame=cb=>setTimeout(()=>cb(Date.now()),0);
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.localStorage.setItem('outline.userId',uid);
  window.eval(appJs);
  const $=s=>window.document.querySelector(s), $$=s=>[...window.document.querySelectorAll(s)];
  $('#name-input').value=name;
  $('#login-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await sleep(400);
  return {window,$,$$,recv,
    rawSend(o){socks[socks.length-1].send(JSON.stringify(o));},
    async newDoc(t){$('#new-doc-btn').click();await sleep(40);$('#newdoc-title').length;t.value=t;$('#newdoc-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await sleep(400);},
    async tab(t){[...$$('.doc-tab-label')].find(l=>l.textContent.includes(t)).click();await sleep(200);},
    first(){return $('#outline > .node-outer').dataset.nodeId;},
    badge(id){return $$(`.node-outer[data-node-id="${id}"] .lock-badge`).map(e=>e.textContent).join('|');},
    cls(id){return $(`.node-outer[data-node-id="${id}"] > .node`)?.className||'';},
  };
}
(async()=>{
  await new Promise(r=>serverMod.server.listen(3800,r));
  // B 建跟读文档并挂跟读
  const B=await user('跟编','uB');
  $('#newdoc'); 
  process.exit(0);
})();
