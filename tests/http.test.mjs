import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createApp} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {initialState} from '../lib/core.mjs';
const botToken='123456789:testing-only-do-not-use';
function signed(id){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Test'})});const key=createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString()}
test('HTTP: auth, origin, persistent revision, cancellation and private files',async()=>{
  const store=new Store(':memory:',42),server=createApp({botToken,ownerId:42,botUsername:'test_bot',port:0},store);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  // An explicit origin in config makes the origin policy identical to production.
  const production=createApp({botToken,ownerId:42,botUsername:'test_bot',publicUrl:base},store);
  await new Promise(r=>server.close(r));await new Promise(r=>production.listen(Number(new URL(base).port),'127.0.0.1',r));
  let cookie='';const call=(path,body,origin=base)=>fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json',origin}:{}),cookie},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await call('state')).status,401);
    assert.equal((await call('session',{initData:signed(7)})).status,403);
    assert.equal((await call('session',{initData:signed(42)},'https://attacker.invalid')).status,403);
    const login=await call('session',{initData:signed(42)});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await call('state')).status,200);
    const session=(await login.json()).session;
    assert.equal((await fetch(base+'/api/state',{headers:{authorization:'Bearer '+session}})).status,200);
    assert.equal((await fetch(base+'/api/state',{headers:{authorization:'Bearer wrong-token'}})).status,401);
    const record={name:'Test',date:'2026-11-02',time:'10:00',duration:60,service:'Мужская стрижка',status:'confirmed',type:'visit'};
    const first=await call('record',{revision:0,record});assert.equal(first.status,200);const saved=await first.json();assert.equal(saved.revision,1);
    assert.equal((await call('record',{revision:0,record})).status,409);
    assert.equal((await call('record',{revision:1,record:{...record,time:'10:30'}})).status,400);
    assert.equal((await call('cancel',{revision:1,id:saved.records[0].id})).status,200);
    assert.equal((await call('record',{revision:2,record})).status,200);
    const invite=await call('invite',{});assert.equal(invite.status,200);assert.match((await invite.json()).url,/start=join_/);
    for(const path of ['/.env','/server.mjs','/lib/store.mjs','/data/smena.sqlite','/../server.mjs'])assert.equal((await fetch(base+path)).status,404);
    const exported=await (await call('export')).json();
    assert.equal(exported.records.length,2);assert.equal(exported.botToken,undefined);
    const clean={format:'smena-v2',...initialState()};
    const large={...clean,clientNotes:Object.fromEntries(Array.from({length:80},(_,i)=>['Client '+i,'x'.repeat(900)]))};
    assert.equal((await call('import-preview',{backup:large})).status,200);
    assert.equal((await call('import',{revision:3,backup:clean})).status,200);
    assert.equal((await (await call('state')).json()).records.length,0);
    const copies=await (await call('backups')).json();assert.equal(copies.backups.length,1);
    assert.equal((await call('restore-copy',{revision:4,id:copies.backups[0].id})).status,200);
    assert.equal((await (await call('state')).json()).records.length,2);
    assert.equal((await call('day',{revision:5,date:'2026-11-03',override:{closed:false,start:'12:00',end:'17:00'}})).status,200);
    assert.equal((await (await call('state')).json()).dayOverrides['2026-11-03'].start,'12:00');
  }finally{await new Promise(r=>production.close(r));store.close()}
});

test('Revocation during body upload prevents a write with an already revoked session',async()=>{
  const store=new Store(':memory:',42);
  store.redeemInvite(store.createInvite(),7);
  const session=store.createSession(7),original=store.sessionUser.bind(store);let scheduled=false;
  store.sessionUser=(...args)=>{
    const id=original(...args);
    if(id===7&&!scheduled){scheduled=true;queueMicrotask(()=>store.revokeFriend())}
    return id;
  };
  const server=createApp({ownerId:42,botToken,publicUrl:'http://smena.test'},store);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/day',{
      method:'POST',headers:{authorization:'Bearer '+session,origin:'http://smena.test','content-type':'application/json'},
      body:JSON.stringify({revision:0,date:'2026-11-03',override:{closed:true}})
    });
    assert.equal(response.status,401);
    assert.equal(store.friend(),null);assert.equal(store.read().revision,0);
  }finally{await new Promise(r=>server.close(r));store.close()}
});
