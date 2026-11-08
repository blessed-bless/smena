import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {icsToRecords,apiToRecords,wallToInstant,createSync,validateFeedUrl,assertPublicHost,internalAddress} from '../lib/sync.mjs';
import {Store} from '../lib/store.mjs';
import {validateBackup,initialState,validateRecord} from '../lib/core.mjs';
import {freeWindows} from '../lib/bot.mjs';
import {createApp} from '../server.mjs';

const ics=(events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events.flatMap(e=>['BEGIN:VEVENT',...e,'END:VEVENT']),'END:VCALENDAR'].join('\r\n');
const feed=ics([
  ['UID:a1@google.com','DTSTART:20261110T040000Z','DTEND:20261110T050000Z','SUMMARY:Иван Петров - Мужская стрижка','DESCRIPTION:Телефон: +7 900\\nКомментарий'],
  ['UID:a2@google.com','DTSTART;TZID=Europe/Moscow:20261110T150000','DTEND;TZID=Europe/Moscow:20261110T163000','SUMMARY:Олег','STATUS:CANCELLED'],
  ['UID:a3@google.com','DTSTART;VALUE=DATE:20261111','SUMMARY:Весь день'],
  ['UID:a4@google.com','DTSTART:20261112T030700Z','DURATION:PT45M','SUMMARY:Длинное имя кли',' ента','BEGIN:VALARM','SUMMARY:alarm','END:VALARM'],
]);

test('iCal: UTC, TZID, folded lines, cancelled and all-day events',()=>{
  const r=icsToRecords(feed,'Asia/Omsk');
  assert.equal(r.length,3);
  assert.deepEqual([r[0].date,r[0].time,r[0].duration,r[0].name,r[0].service],['2026-11-10','10:00',60,'Иван Петров','Мужская стрижка']);
  assert.match(r[0].note,/\+7 900\nКомментарий/);
  assert.deepEqual([r[1].time,r[1].duration,r[1].status],['18:00',90,'cancelled']);
  assert.deepEqual([r[2].time,r[2].duration,r[2].name],['09:07',45,'Длинное имя клиента']);
  assert.ok(r.every(x=>x.source==='yclients'&&/^yc-[a-f0-9]{32}$/.test(x.id)));
  assert.equal(icsToRecords(feed,'Asia/Omsk',{from:'2026-11-11',to:'2026-12-31'}).length,1);
});

test('iCal: phone and service are taken from description when the title has only a name',()=>{
  const [r]=icsToRecords(ics([['UID:d1','DTSTART:20261110T040000Z','DURATION:PT1H','SUMMARY:Мария','DESCRIPTION:Услуги: Стрижка\\, укладка\\nТелефон: +7 (900) 123-45-67']]),'Asia/Omsk');
  assert.deepEqual([r.name,r.service,r.phone],['Мария','Стрижка, укладка','+79001234567']);
});

test('Wall time conversion respects daylight saving changes',()=>{
  assert.equal(wallToInstant('2026-07-01','12:00:00','Europe/Berlin').toISOString(),'2026-07-01T10:00:00.000Z');
  assert.equal(wallToInstant('2026-12-01','12:00:00','Europe/Berlin').toISOString(),'2026-12-01T11:00:00.000Z');
});

test('YCLIENTS API records map to read-only visits',()=>{
  const now=new Date('2026-11-10T12:00:00Z');
  const r=apiToRecords([
    {id:1,datetime:'2026-11-10T10:00:00+06:00',seance_length:3600,attendance:1,services:[{title:'Стрижка',cost:1500},{title:'Борода',cost:700}],client:{name:'Анна',phone:'+79001234567'},comment:'Без машинки'},
    {id:2,date:'2026-11-11 12:30:00',seance_length:1800,attendance:-1,services:[],client:null},
    {id:3,datetime:'2026-11-12T10:00:00+06:00',deleted:true},
  ],'Asia/Omsk',now);
  assert.equal(r.length,2);
  assert.deepEqual([r[0].time,r[0].status,r[0].price,r[0].service,r[0].phone],['10:00','done',2200,'Стрижка, Борода','+79001234567']);
  assert.deepEqual([r[1].date,r[1].time,r[1].duration,r[1].status,r[1].name],['2026-11-11','12:30',30,'noshow','Клиент']);
});

test('applySync replaces only YCLIENTS records in window and reports changes',()=>{
  const store=new Store(':memory:',1);
  store.mutate(0,s=>{s.records.push(validateRecord({name:'Локальный',service:'Мужская стрижка',date:'2026-11-10',time:'12:00',duration:60},s));return s});
  const first=icsToRecords(feed,'Asia/Omsk'),win={from:'2026-11-01',to:'2026-11-30'};
  let res=store.applySync(first,win);
  assert.equal(res.changed,true);assert.equal(res.added.length,3);assert.equal(store.read().records.length,4);
  const rev=store.read().revision;
  res=store.applySync(icsToRecords(feed,'Asia/Omsk'),win);
  assert.equal(res.changed,false);assert.equal(store.read().revision,rev);
  res=store.applySync(first.filter(r=>r.name!=='Иван Петров'),win);
  assert.equal(res.removed.length,1);assert.equal(res.removed[0].name,'Иван Петров');
  assert.ok(store.read().records.some(r=>r.name==='Локальный'));
  store.applySync([],null);assert.deepEqual(store.read().records.map(r=>r.name),['Локальный']);
});

test('Background sync does not invalidate an open form revision',()=>{
  const store=new Store(':memory:',1),rev=store.read().revision;
  store.applySync(icsToRecords(feed,'Asia/Omsk'),null);
  assert.equal(store.read().revision,rev);
  store.mutate(rev,s=>{s.records.push(validateRecord({name:'После синхронизации',service:'Мужская стрижка',date:'2026-11-10',time:'14:00',duration:60},s));return s});
  assert.equal(store.read().records.length,4);
});

test('Local visits cannot overlap synced YCLIENTS records',()=>{
  const s=initialState();s.records=icsToRecords(feed,'Asia/Omsk');
  assert.throws(()=>validateRecord({name:'X',service:'Мужская стрижка',date:'2026-11-10',time:'10:30',duration:60},s),/занято/);
});

test('Backups keep synced records with non-15-minute times',()=>{
  const s=initialState();s.records=icsToRecords(feed,'Asia/Omsk');
  const restored=validateBackup({format:'smena-v2',...s});
  assert.equal(restored.records.find(r=>r.time==='09:07').source,'yclients');
});

test('Sync loop: notifications only after first seed, errors are stored',async()=>{
  const store=new Store(':memory:',1),sent=[];let body=feed,statusCode=200;
  const today=new Date().toISOString().slice(0,10).replaceAll('-','');
  const fetchImpl=async()=>new Response(body,{status:statusCode});
  const sync=createSync({config:{},store,notify:async t=>{sent.push(t)},fetchImpl,lookup:async()=>[{address:'203.0.113.10'}]});
  assert.equal(sync.configure('http://insecure.example/cal.ics'),null);
  assert.ok(sync.configure('webcal://calendar.google.com/calendar/ical/x/private-y/basic.ics'));
  body=ics([['UID:t1','DTSTART:'+today+'T235900Z','DURATION:PT30M','SUMMARY:Первый']]);
  let st=await sync.run();assert.equal(st.error,'');assert.equal(st.mode,'ics');assert.equal(st.host,'calendar.google.com');assert.equal(sent.length,0);
  body=ics([['UID:t1','DTSTART:'+today+'T235900Z','DURATION:PT30M','SUMMARY:Первый'],['UID:t2','DTSTART:'+today+'T235900Z','DURATION:PT30M','SUMMARY:Второй']]);
  await sync.run();assert.equal(sent.length,1);assert.match(sent[0],/Новая запись в YCLIENTS[\s\S]*Второй/);
  statusCode=404;st=await sync.run();assert.match(st.error,/секретный адрес/i);
  statusCode=200;body='<html>login</html>';st=await sync.run();assert.match(st.error,/не календарь/);
  sync.configure(null);assert.equal(sync.mode(),null);assert.equal(store.read().records.length,0);
});

test('Feed URL validation: https only, no credentials',()=>{
  assert.equal(validateFeedUrl('https://user:pw@example.com/a.ics'),null);
  assert.equal(validateFeedUrl('ftp://example.com/a.ics'),null);
  assert.equal(validateFeedUrl('webcal://example.com/a.ics'),'https://example.com/a.ics');
});

test('Free windows skip busy time and the past',()=>{
  const s=initialState();s.records=[{id:'1',date:'2026-11-10',time:'12:00',duration:60,status:'confirmed',type:'visit'},{id:'2',date:'2026-11-10',time:'15:00',duration:30,status:'cancelled',type:'visit'}];
  assert.deepEqual(freeWindows(s,'2026-11-10','11:10'),['11:15–12:00','13:00–19:00']);
  s.settings.workdays=[];assert.equal(freeWindows(s,'2026-11-10','09:00'),null);
});

test('Daily snapshot is created once per day and old copies are rotated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'smena-snap-')),store=new Store(join(dir,'db.sqlite'),1),snaps=join(dir,'snaps');
  try{
    for(let d=1;d<=5;d++)store.snapshot(snaps,3,`2026-11-0${d}`);
    store.snapshot(snaps,3,'2026-11-05');
    assert.deepEqual(readdirSync(snaps).sort(),['smena-2026-11-03.sqlite','smena-2026-11-04.sqlite','smena-2026-11-05.sqlite']);
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('HTTP: sync settings are owner-only and validated',async()=>{
  const botToken='123:t',store=new Store(':memory:',42);
  const sync=createSync({config:{},store,fetchImpl:async()=>new Response(feed),lookup:async()=>[{address:'203.0.113.10'}]});
  const signed=id=>{const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})});const key=createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));return p.toString()};
  const server=createApp({botToken,ownerId:42,port:0},store,sync);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,base='http://127.0.0.1:'+port;
  const app=createApp({botToken,ownerId:42,port},store,sync);await new Promise(r=>server.close(r));await new Promise(r=>app.listen(port,'127.0.0.1',r));
  try{
    const login=async id=>{const r=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({initData:signed(id)})});return (await r.json()).session};
    const call=(token,path,body)=>fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json',origin:base}:{})},body:body&&JSON.stringify(body)});
    const owner=await login(42);
    assert.equal((await call(owner,'invite',{})).status,503); // BOT_USERNAME не задан — не выдаём ссылку t.me/undefined
    assert.equal((await call(owner,'sync-now',{})).status,400);
    assert.equal((await call(owner,'sync-config',{url:'javascript:alert(1)'})).status,400);
    const ok=await call(owner,'sync-config',{url:'https://calendar.example/basic.ics'});assert.equal(ok.status,200);
    const data=await ok.json();assert.equal(data.sync.mode,'ics');assert.equal(data.records.length,3);assert.equal(JSON.stringify(data).includes('basic.ics'),false);
    const state=await (await call(owner,'state')).json();assert.equal(state.sync.count,3);
    const id=state.records[0].id;
    assert.equal((await call(owner,'cancel',{revision:state.revision,id})).status,403);
    assert.equal((await (await fetch(base+'/api/export',{headers:{authorization:'Bearer '+owner}})).text()).includes('basic.ics'),false);
    store.redeemInvite(store.createInvite(),7);const friend=await login(7);
    assert.equal((await call(friend,'sync-config',{url:null})).status,403);
    assert.equal((await call(friend,'sync-now',{})).status,200);
    assert.equal((await (await fetch(base+'/health')).json()).yclientsConnected,true);
  }finally{await new Promise(r=>app.close(r))}
});

test('Calendar fetch refuses internal addresses and re-checks redirects',async()=>{
  for(const a of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.1','169.254.169.254','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(internalAddress(a),true,a);
  for(const a of ['8.8.8.8','203.0.113.10','2a00:1450:4010::64'])assert.equal(internalAddress(a),false,a);
  await assert.rejects(assertPublicHost('https://127.0.0.1/a.ics'),/внутреннюю сеть/);
  await assert.rejects(assertPublicHost('https://[::1]/a.ics'),/внутреннюю сеть/);
  await assert.rejects(assertPublicHost('https://cal.example/a.ics',async()=>[{address:'93.184.216.34'},{address:'10.0.0.5'}]),/внутреннюю сеть/);
  await assertPublicHost('https://cal.example/a.ics',async()=>[{address:'93.184.216.34'}]);
  const dir=mkdtempSync(join(tmpdir(),'smena-ssrf-')),store=new Store(join(dir,'db.sqlite'),initialState());
  try{
    const asked=[],lookup=async h=>[{address:h==='inner.example'?'192.168.0.10':'203.0.113.10'}];
    const fetchImpl=async u=>{asked.push(u);return new Response('',{status:302,headers:{location:'https://inner.example/x.ics'}})};
    const sync=createSync({config:{},store,fetchImpl,lookup});
    sync.configure('https://cal.example/feed.ics');
    assert.match((await sync.run()).error,/внутреннюю сеть/);
    assert.deepEqual(asked,['https://cal.example/feed.ics']);
  }finally{store.close?.();rmSync(dir,{recursive:true,force:true})}
});
