import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../lib/store.mjs';
import {initialState} from '../lib/core.mjs';
import {collectNotifications,sendNotifications,summaryForDay} from '../lib/reminders.mjs';
const visit={id:'one',name:'Клиент',date:'2026-11-02',time:'10:00',duration:30,service:'Борода',status:'confirmed',type:'visit'};
const now={date:'2026-11-02',time:'09:40'};
function storeWithVisits(){const s=new Store(':memory:',42);s.mutate(0,v=>({...v,records:[visit,{...visit,id:'two',time:'10:30'}]}));return s}
test('Reminder includes next midnight, excludes cancelled, arrived and blocked time',()=>{
  const state=initialState();state.records=[{...visit,date:'2026-11-03',time:'00:10'}];
  assert.equal(collectNotifications(state,{date:'2026-11-02',time:'23:50'}).length,1);
  for(const status of ['cancelled','noshow','done','arrived']){state.records[0].status=status;assert.equal(collectNotifications(state,{date:'2026-11-02',time:'23:50'}).length,0)}
  state.records[0]={...visit,type:'block'};assert.equal(collectNotifications(state,now).length,0);
});
test('Send is deduplicated; failed delivery can retry',async()=>{
  const s=storeWithVisits(),sent=[];const config={ownerId:42};
  await sendNotifications({config,store:s,now,send:async()=>{throw Error('network')}});
  await sendNotifications({config,store:s,now,send:async(id,text)=>sent.push({id,text})});
  await sendNotifications({config,store:s,now,send:async()=>assert.fail('duplicate')});
  assert.equal(sent.length,1);assert.equal(sent[0].id,42);s.close();
});
test('Revoking access or cancelling the next visit takes effect between asynchronous sends',async()=>{
  const s=storeWithVisits();s.mutate(1,v=>({...v,settings:{...v.settings,reminderMinutes:60}}));
  s.redeemInvite(s.createInvite(),7);const recipients=[];
  await sendNotifications({config:{ownerId:42},store:s,now,send:async id=>{recipients.push(id);if(recipients.length===1)s.revokeFriend()}});
  assert.deepEqual(recipients,[7,42]);s.close();
  const other=storeWithVisits();other.mutate(1,v=>({...v,settings:{...v.settings,reminderMinutes:60}}));let count=0;
  await sendNotifications({config:{ownerId:42},store:other,now,send:async()=>{count++;other.mutate(other.read().revision,v=>({...v,records:v.records.map(r=>r.id==='two'?{...r,status:'cancelled'}:r)}))}});
  assert.equal(count,1);other.close();
});
test('Large daily summary fits a Telegram message and reports omitted visits',()=>{
  const state=initialState();state.records=Array.from({length:60},(_,i)=>({...visit,id:String(i),name:'Имя'.repeat(25),service:'Услуга'.repeat(15)}));
  const text=summaryForDay(state,visit.date);
  assert.ok(text.length<=4000);assert.match(text,/ещё|Ещё/);assert.match(text,/YCLIENTS не подключён/);
});
