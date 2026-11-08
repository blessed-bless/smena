import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyTelegram, initialState, validateRecord, validateSettings} from '../lib/core.mjs';
import {Store} from '../lib/store.mjs';

const token='123456789:testing-only-do-not-use', now=1800000000;
function signed(id=42, at=now){
  const p=new URLSearchParams({auth_date:String(at),query_id:'test',user:JSON.stringify({id,first_name:'Test'})});
  const key=createHmac('sha256','WebAppData').update(token).digest();
  p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  return p.toString();
}
test('Telegram HMAC rejects tampering, duplicates, expired and future data',()=>{
  assert.equal(verifyTelegram(signed(),token,now).id,42);
  for(const raw of [signed().replace('Test','Fake'),signed()+'&auth_date='+now,signed(42,now-3601),signed(42,now+31),''])
    assert.throws(()=>verifyTelegram(raw,token,now));
});
const record={name:'Тестовый клиент',date:'2026-11-02',time:'10:00',duration:60,service:'Мужская стрижка',status:'confirmed',note:'',price:0,phone:'',type:'visit'};
test('Dates, working hours, service and lengths validated on server',()=>{
  const state=initialState();
  assert.equal(validateRecord(record,state).duration,60);
  for(const changed of [{date:'2026-02-30'},{time:'18:30'},{duration:-1},{name:' '},{service:'unknown'},{note:'x'.repeat(1001)}])
    assert.throws(()=>validateRecord({...record,...changed},state));
  state.settings.workdays=[];
  assert.throws(()=>validateRecord(record,state));
});
test('Visit time uses a 5-minute step',()=>{
  const state=initialState();
  assert.equal(validateRecord({...record,time:'14:55',duration:30},state).time,'14:55');
  assert.throws(()=>validateRecord({...record,time:'14:52',duration:30},state),/шагом 5 минут/);
});
test('Overlap rejected, adjacent times allowed, cancelled visits release their time',()=>{
  const state=initialState();state.records=[{...record,id:'one'}];
  assert.throws(()=>validateRecord({...record,time:'10:30'},state));
  assert.equal(validateRecord({...record,time:'11:00'},state).time,'11:00');
  assert.equal(validateRecord({...record,id:'one'},state).time,'10:00');
  state.records[0].status='cancelled';
  assert.equal(validateRecord(record,state).time,'10:00');
  state.records=[{...record,id:'block',type:'block',name:'Перерыв',service:'Перерыв'}];
  assert.throws(()=>validateRecord({...record,time:'10:30'},state));
});
test('Settings preserve valid zone, services and workday boundaries',()=>{
  const s=initialState().settings;
  assert.equal(validateSettings(s).timeZone,'Europe/Moscow');
  for(const changed of [{timeZone:'bad-zone'},{start:'19:00',end:'10:00'},{workdays:[7]},{services:[]},{reminderMinutes:900}])
    assert.throws(()=>validateSettings({...s,...changed}));
});
test('SQLite revisions prevent stale updates; failed mutation leaves state unchanged',()=>{
  const store=new Store(':memory:',42);
  assert.equal(store.read().revision,0);
  assert.equal(store.mutate(0,s=>({...s,records:[{...record,id:'one'}]})).revision,1);
  assert.throws(()=>store.mutate(0,s=>({...s,records:[]})),e=>e.code==='CONFLICT'&&e.status===409);
  assert.throws(()=>store.mutate(1,()=>{throw Error('failed')}));
  assert.equal(store.read().records.length,1);
  assert.equal(store.read().revision,1);
  store.close();
});
test('Private access: strangers denied, one-use expiring invite, owner always allowed',()=>{
  const store=new Store(':memory:',42);
  assert.equal(store.allowed(42),true);assert.equal(store.allowed(7),false);
  const invite=store.createInvite(now);
  assert.equal(store.redeemInvite(invite,7,now+1),true);
  assert.equal(store.allowed(7),true);
  assert.equal(store.redeemInvite(invite,8,now+2),false);
  assert.equal(store.allowed(8),false);
  store.revokeFriend();assert.equal(store.allowed(7),false);assert.equal(store.allowed(42),true);
  const expired=store.createInvite(now);
  assert.equal(store.redeemInvite(expired,8,now+86401),false);
  store.close();
});
test('Sessions expire and revoked access invalidates existing sessions',()=>{
  const store=new Store(':memory:',42);
  const invite=store.createInvite(now);store.redeemInvite(invite,7,now);
  const session=store.createSession(7,now);
  assert.equal(store.sessionUser(session,now+1),7);
  assert.equal(store.sessionUser(session,now+28801),null);
  store.revokeFriend();assert.equal(store.sessionUser(session,now+1),null);
  store.close();
});
