import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,validateBackup,validateDayOverride,validateRecord} from '../lib/core.mjs';
import {workday} from '../shared.mjs';
import {Store} from '../lib/store.mjs';
const visit={id:'visit-one',name:'Тестовый клиент',date:'2026-11-02',time:'10:00',duration:60,service:'Мужская стрижка',status:'confirmed',note:'',price:0,phone:'',type:'visit'};
const backup=state=>({format:'smena-v2',exportedAt:'2026-11-01T00:00:00Z',...state});
test('Date override opens a weekly day off, shortens a shift, and can be removed',()=>{
  const state=initialState();state.settings.workdays=[];
  assert.equal(workday(state,visit.date).closed,true);
  const override=validateDayOverride(visit.date,{closed:false,start:'12:00',end:'18:00'},state);
  state.dayOverrides[visit.date]=override;
  assert.equal(workday(state,visit.date).start,'12:00');
  assert.equal(workday(state,visit.date).closed,false);
  assert.equal(validateRecord({...visit,time:'12:00'},state).time,'12:00');
  assert.throws(()=>validateRecord(visit,state));
  assert.equal(validateDayOverride(visit.date,null,state),null);
});
test('Day edits cannot hide active appointments or accept malformed dates/hours',()=>{
  const state=initialState();state.records=[visit];
  for(const value of [{closed:true},{closed:false,start:'11:00',end:'19:00'},{closed:false,start:'18:00',end:'10:00'}])
    assert.throws(()=>validateDayOverride(visit.date,value,state));
  assert.throws(()=>validateDayOverride('2026-02-30',{closed:true},state));
  state.records[0]={...visit,status:'cancelled'};
  assert.equal(validateDayOverride(visit.date,{closed:true},state).closed,true);
});
test('Backup accepts historical services/hours and drops access data',()=>{
  const state=initialState();state.settings.start='12:00';state.records=[{...visit,service:'Старая услуга'}];
  state.clientNotes['Тестовый клиент']='Предпочитает плавный переход';
  const imported=validateBackup({...backup(state),ownerId:7,sessions:['not-restored'],botToken:'not-restored'});
  assert.equal(imported.records[0].service,'Старая услуга');
  assert.equal(imported.records[0].time,'10:00');
  assert.equal(imported.clientNotes['Тестовый клиент'],'Предпочитает плавный переход');
  assert.equal(imported.ownerId,undefined);assert.equal(imported.sessions,undefined);assert.equal(imported.botToken,undefined);
});
test('Backup rejects unknown formats, duplicate IDs, invalid notes and overlapping live visits',()=>{
  const state=initialState();state.records=[visit];
  for(const value of [{format:'yclients',records:[]},{...backup(state),records:[visit,visit]},{...backup(state),clientNotes:{Test:3}},{...backup(state),records:[visit,{...visit,id:'another',time:'10:30'}]}])
    assert.throws(()=>validateBackup(value));
  assert.equal(validateBackup({...backup(state),format:'smena-v1',dayOverrides:undefined}).records.length,1);
});
test('Restore is atomic, saves a recovery copy, rejects stale revisions and keeps only five copies',()=>{
  const store=new Store(':memory:',42);
  store.mutate(0,s=>({...s,records:[visit]}));
  const clean=validateBackup(backup(initialState()));
  assert.equal(store.restore(1,clean).records.length,0);
  const saved=store.backups()[0];assert.equal(saved.records,1);
  assert.equal(store.backup(saved.id).records[0].name,visit.name);
  assert.throws(()=>store.restore(1,clean),e=>e.code==='CONFLICT');
  assert.equal(store.backups().length,1);
  store.restore(2,validateBackup(backup(store.backup(saved.id))));
  assert.equal(store.read().records.length,1);
  for(let i=0;i<6;i++)store.restore(store.read().revision,clean);
  assert.equal(store.backups().length,5);
  assert.equal(store.allowed(42),true);assert.equal(store.allowed(7),false);
  store.close();
});

import {validateRecord as vr,initialState as is0} from '../lib/core.mjs';
test('Records imported from YCLIENTS keep source and cannot be edited via API',()=>{
  const s=is0(),rec={id:'y1',name:'Клиент',service:'Мужская стрижка',date:'2026-11-09',time:'10:00',duration:60,status:'confirmed',source:'yclients',externalId:'42'};
  s.records=[rec];
  const kept=vr({...rec,status:'done',source:undefined},s,{checkSchedule:false});
  assert.equal(kept.source,'yclients');assert.equal(kept.externalId,'42');
  const fresh=vr({...rec,id:undefined,time:'12:00',source:'yclients'},s);
  assert.equal(fresh.source,undefined);
});
