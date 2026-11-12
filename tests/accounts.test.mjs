import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {initialState} from '../lib/core.mjs';
import {createYclients,tokenBox} from '../lib/yclients.mjs';
import {createSyncHub} from '../lib/sync.mjs';
import {createApp} from '../server.mjs';

const botToken='123:test';
const signed=id=>{const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})});const key=createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));return p.toString()};

test('Store: the pre-0.6 single cabinet moves to the owner, the friend keeps access',()=>{
  const dir=mkdtempSync(join(tmpdir(),'smena-mig-')),file=join(dir,'db.sqlite');
  try{
    const old=new DatabaseSync(file),state=initialState();state.records=[{id:'r1',name:'Анна'}];
    old.exec(`CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE access(id INTEGER PRIMARY KEY CHECK(id=1),user_id INTEGER NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
    old.prepare('INSERT INTO state VALUES(1,?,7)').run(JSON.stringify(state));old.exec("INSERT INTO access VALUES(1,77); INSERT INTO audit(at,action) VALUES('2026-11-01','Старое'); INSERT INTO meta VALUES('sync_ics','https://c.example/a.ics')");old.close();
    const store=new Store(file,42);
    assert.equal(store.read().revision,7);assert.equal(store.read().records[0].name,'Анна');
    assert.equal(store.cabinetOf(77),42);assert.equal(store.friend(),77);assert.equal(store.recipient(),77);
    assert.equal(store.audit()[0].action,'Старое');assert.equal(store.meta('sync_ics'),'https://c.example/a.ics');
    store.close();
    const again=new Store(file,42);assert.equal(again.read().revision,7);again.close(); // повторный запуск ничего не переносит заново
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Store: cabinets are isolated — records, settings, meta, invites, copies, deletion',()=>{
  const store=new Store(':memory:',42),b=store.createCabinet(500);
  assert.equal(store.cabinetOf(500),500);assert.equal(store.cabinetOf(501),null);
  b.mutate(0,s=>{s.records.push({id:'b1',name:'Борис'});return s});b.meta('sync_ics','https://b.example/x.ics');b.claim('morning:2026-11-12');
  assert.equal(store.read().records.length,0);assert.equal(store.meta('sync_ics'),undefined);assert.equal(store.claim('morning:2026-11-12'),true);
  assert.equal(b.audit().length,1);assert.equal(store.audit().length,0);
  b.restore(1,{...initialState(),records:[]});assert.equal(b.backups().length,1);assert.equal(store.backups().length,0);
  assert.throws(()=>store.backup(b.backups()[0].id),/не найдена/);
  // Приглашение ведёт в свой кабинет; занятый кабинет второе приглашение не принимает.
  assert.equal(b.redeemInvite(b.createInvite(),600),true);assert.equal(store.cabinetOf(600),500);assert.equal(b.recipient(),600);
  assert.equal(store.redeemInvite(store.createInvite(),600),false); // уже есть доступ
  assert.equal(store.redeemInvite(store.createInvite(),601),true);assert.equal(store.cabinetOf(601),42);
  // Свой кабинет заменяет гостевой доступ.
  store.createCabinet(601);assert.equal(store.cabinetOf(601),601);assert.equal(store.friend(),null);
  assert.throws(()=>store.deleteCabinet(),/нельзя/);
  b.account({token:'x'});const session=store.createSession(600);b.deleteCabinet();
  assert.equal(store.cabinetOf(500),null);assert.equal(store.cabinetOf(600),null);assert.equal(store.sessionUser(session),null);
  assert.equal(store.scope(500).account(),null);assert.equal(store.scope(500).meta('sync_ics'),undefined);assert.equal(store.users().includes(600),false);
  assert.throws(()=>b.read(),/удалён/);
});

test('Token box: sealed token opens only with the same secret',()=>{
  const box=tokenBox('secret-a'),sealed=box.seal('user-token-1');
  assert.notEqual(sealed,box.seal('user-token-1'));assert.equal(sealed.includes('user-token'),false);
  assert.equal(box.open(sealed),'user-token-1');assert.equal(tokenBox('secret-b').open(sealed),null);assert.equal(box.open('garbage'),null);
});

// Подмена API YCLIENTS: два пользователя, у второго включена 2FA и два филиала.
function fakeYclients(){
  const calls=[];
  const users={'anna@x.ru':{password:'pass1',id:11,name:'Анна',token:'tok-anna'},'79990001122':{password:'pass2',id:22,name:'Вера',token:'tok-vera',twofa:'4321'}};
  const companies={'tok-anna':[{id:1,title:'Салон на Ленина',timezone_name:'Asia/Yekaterinburg'}],'tok-vera':[{id:1,title:'Салон на Ленина'},{id:2,title:'Салон на Мира',address:'Мира, 5'}]};
  const staff={1:[{id:101,name:'Анна',user_id:11},{id:102,name:'Ольга',user_id:0},{id:103,name:'Уволена',user_id:22,fired:1}],2:[{id:201,name:'Вера К.',user_id:0}]};
  const ok=(data,status=200)=>new Response(JSON.stringify({success:true,data,meta:[]}),{status});
  const fail=(status,message)=>new Response(JSON.stringify({success:false,data:null,meta:{message}}),{status});
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url),auth=init.headers?.Authorization||'',body=init.body?JSON.parse(init.body):null;calls.push({path:u.pathname,auth,body});
    if(!auth.startsWith('Bearer partner-1'))return fail(401,'Partner token invalid');
    const userToken=auth.split('User ')[1];
    if(u.pathname==='/api/v1/auth'){
      const user=users[body.login];if(!user||user.password!==body.password)return fail(400,'Неверный логин или пароль');
      if(user.twofa&&!body['2fa'])return ok({uuid:'uuid-1',flow:'login',transport:{type:'email',recipient:'v***@x.ru'},attempts_left:3});
      if(user.twofa&&(body['2fa'].uuid!=='uuid-1'||body['2fa'].secret!==user.twofa))return fail(400,'Неверный код подтверждения');
      return ok({id:user.id,user_token:user.token,name:user.name},201);
    }
    if(u.pathname==='/api/v1/companies')return companies[userToken]?ok(companies[userToken]):fail(401,'Unauthorized');
    if(u.pathname==='/api/v1/company/1/services')return ok(u.searchParams.get('staff_id')==='101'?[{id:1,title:'Мужская стрижка',price_min:1500,staff:[{id:101,seance_length:2700}]},{id:2,title:'Борода',price_min:800.4,seance_length:1500},{id:3,title:'Мужская стрижка',price_min:1}]:[]);
    const m=u.pathname.match(/^\/api\/v1\/company\/(\d+)\/staff$/);if(m)return ok(staff[m[1]]||[]);
    const r=u.pathname.match(/^\/api\/v1\/records\/(\d+)$/);
    if(r){const sid=u.searchParams.get('staff_id');return ok(sid==='101'?[{id:9001,datetime:'2026-11-20T12:00:00+05:00',seance_length:3600,attendance:2,client:{name:'Клиент Анны',phone:'79001112233'},services:[{title:'Стрижка',cost:1500}]}]:[])}
    return fail(404,'Not found');
  };
  return {fetchImpl,calls};
}

test('YCLIENTS client: login, 2FA, wrong password and rate limit are told apart',async()=>{
  const {fetchImpl}=fakeYclients(),yc=createYclients({partnerToken:'partner-1',fetchImpl});
  assert.deepEqual((await yc.login('anna@x.ru','pass1')).user,{id:11,name:'Анна',token:'tok-anna'});
  const need=await yc.login('79990001122','pass2');assert.deepEqual(need.need2fa,{uuid:'uuid-1',recipient:'v***@x.ru',attemptsLeft:3});
  assert.equal((await yc.login('79990001122','pass2',{uuid:'uuid-1',code:'4321'})).user.token,'tok-vera');
  await assert.rejects(yc.login('79990001122','pass2',{uuid:'uuid-1',code:'0000'}),/код/);
  await assert.rejects(yc.login('anna@x.ru','nope'),e=>e.code==='YC_LOGIN');
  assert.deepEqual((await yc.staff('tok-anna',1)).map(s=>s.id),[101,102]); // уволенные не показываются
  const busy=createYclients({partnerToken:'partner-1',fetchImpl:async()=>new Response('{}',{status:429})});
  await assert.rejects(busy.login('a','b'),e=>e.status===429);
  await assert.rejects(createYclients({}).login('a','b'),e=>e.code==='YC_OFF');
  const down=createYclients({partnerToken:'partner-1',fetchImpl:async()=>{throw Error('ECONNRESET')}});
  await assert.rejects(down.companies('t'),e=>e.code==='YC_DOWN');
});

test('HTTP: any barber signs in with YCLIENTS and gets an isolated cabinet',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'smena-yc-')),file=join(dir,'db.sqlite'),store=new Store(file,42);
  const {fetchImpl,calls}=fakeYclients(),config={botToken,ownerId:42,port:0,yclients:{partnerToken:'partner-1'}};
  const box=tokenBox(botToken),yc=createYclients({partnerToken:'partner-1',fetchImpl});
  const hub=createSyncHub({config,store,box,fetchImpl});
  const probe=createApp(config,store,hub,yc,box);await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port,base='http://127.0.0.1:'+port;await new Promise(r=>probe.close(r));
  config.port=port;const app=createApp(config,store,hub,yc,box);await new Promise(r=>app.listen(port,'127.0.0.1',r));
  const post=(path,body,token)=>fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',origin:base,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const get=(path,token)=>fetch(base+'/api/'+path,{headers:{authorization:'Bearer '+token}});
  try{
    assert.equal((await (await fetch(base+'/api/public')).json()).ycLogin,true);
    const refused=await post('session',{initData:signed(500)});assert.equal(refused.status,403);assert.equal((await refused.json()).error,'NO_CABINET');
    assert.equal((await post('yc/login',{initData:'forged',login:'anna@x.ru',password:'pass1'})).status,401);
    assert.equal((await post('yc/login',{initData:signed(500),login:'anna@x.ru',password:'bad'})).status,400);
    // Один филиал и мастер, привязанный к пользователю: кабинет создаётся сразу, записи уже загружены.
    const anna=await (await post('yc/login',{initData:signed(500),login:'anna@x.ru',password:'pass1'})).json();
    assert.equal(anna.ok,true,JSON.stringify(anna));assert.equal(anna.created,true);assert.equal(anna.owner,true);
    const a=await (await get('state',anna.session)).json();
    assert.deepEqual(a.account,{name:'Анна',company:'Салон на Ленина',staff:'Анна'});assert.equal(a.settings.timeZone,'Asia/Yekaterinburg');
    assert.deepEqual(a.settings.services,[{name:'Мужская стрижка',duration:45,price:1500},{name:'Борода',duration:30,price:800}]); // услуги мастера из YCLIENTS
    assert.equal(a.sync.mode,'api');assert.equal(a.records.length,1);assert.equal(a.records[0].name,'Клиент Анны');assert.equal(a.canDelete,true);
    assert.ok(calls.some(c=>c.path==='/api/v1/records/1'&&c.auth==='Bearer partner-1, User tok-anna'));
    // Пароль не хранится нигде, токен — только в зашифрованном виде.
    const dump=readFileSync(file).toString('latin1')+readFileSync(file+'-wal').toString('latin1');
    assert.equal(dump.includes('pass1'),false);assert.equal(dump.includes('tok-anna'),false);
    // 2FA и выбор филиала: у Веры два салона и мастер не привязан к пользователю.
    const step=await (await post('yc/login',{initData:signed(600),login:'79990001122',password:'pass2'})).json();
    assert.equal(step.need2fa.recipient,'v***@x.ru');
    assert.equal((await post('yc/login',{initData:signed(600),login:'79990001122',password:'pass2',uuid:step.need2fa.uuid,code:'12ab'})).status,400);
    const choose=(await (await post('yc/login',{initData:signed(600),login:'79990001122',password:'pass2',uuid:step.need2fa.uuid,code:'4321'})).json()).choose;
    assert.deepEqual(choose.companies.map(c=>c.id),[1,2]);assert.equal(choose.staff,undefined);
    const staff=await (await post('yc/staff',{ticket:choose.ticket,companyId:2})).json();assert.deepEqual(staff,{staff:[{id:201,name:'Вера К.',role:'',userId:0}],mine:null});
    assert.equal((await post('yc/connect',{ticket:choose.ticket,companyId:2,staffId:101})).status,400); // мастер не из этого филиала
    assert.equal((await post('yc/connect',{ticket:'forged',companyId:2,staffId:201})).status,400);
    const vera=await (await post('yc/connect',{ticket:choose.ticket,companyId:2,staffId:201})).json();assert.equal(vera.created,true);
    assert.equal((await post('yc/connect',{ticket:choose.ticket,companyId:2,staffId:201})).status,400); // билет одноразовый
    const v=await (await get('state',vera.session)).json();assert.equal(v.settings.services[0].name,'Мужская стрижка'); // у филиала нет услуг — остаются стандартные
assert.equal(v.records.length,0);assert.equal(v.account.company,'Салон на Мира');assert.equal(v.settings.morning,true); // утренний план включён сразу
    // Кабинеты не видят друг друга и не делят ревизию.
    const rec={name:'Только Вера',phone:'',service:'Мужская стрижка',duration:60,price:0,date:'2026-11-16',time:'12:00',status:'confirmed',type:'visit',note:''};
    const saved=await post('record',{revision:v.revision,record:rec},vera.session);assert.equal(saved.status,200,await saved.clone().text());
    assert.equal((await (await get('state',anna.session)).json()).records.some(r=>r.name==='Только Вера'),false);
    // Кабинет владельца бота нетронут.
    assert.equal(store.read().records.length,0);assert.equal(store.account(),null);
    // Отключение YCLIENTS убирает его записи, удаление кабинета — всё остальное.
    const off=await (await post('yc/disconnect',{},anna.session)).json();assert.equal(off.records.length,0);assert.equal(off.sync.mode,null);
    assert.equal((await post('cabinet-delete',{confirm:'нет'},vera.session)).status,400);
    assert.equal((await post('cabinet-delete',{confirm:'удалить'},vera.session)).status,200);
    assert.equal((await get('state',vera.session)).status,401);assert.equal(store.cabinetOf(600),null);
    // Владелец бота свой кабинет удалить не может.
    const own=await (await post('session',{initData:signed(42)})).json();
    assert.equal((await post('cabinet-delete',{confirm:'удалить'},own.session)).status,403);
  }finally{await new Promise(r=>app.close(r));store.close();rmSync(dir,{recursive:true,force:true})}
});

test('HTTP: login attempts per Telegram user are limited',async()=>{
  const store=new Store(':memory:',42),config={botToken,ownerId:42,port:0,yclients:{partnerToken:'partner-1'}};
  const {fetchImpl}=fakeYclients(),yc=createYclients({partnerToken:'partner-1',fetchImpl});
  const probe=createApp(config,store,null,yc);await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port,base='http://127.0.0.1:'+port;await new Promise(r=>probe.close(r));
  config.port=port;const app=createApp(config,store,null,yc);await new Promise(r=>app.listen(port,'127.0.0.1',r));
  try{
    const codes=[];for(let i=0;i<11;i++)codes.push((await fetch(base+'/api/yc/login',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({initData:signed(700),login:'anna@x.ru',password:'bad'})})).status);
    assert.deepEqual(codes,[...Array(10).fill(400),429]);
  }finally{await new Promise(r=>app.close(r))}
});

test('Store: a cabinet saved by an older version gets defaults for new settings',()=>{
  const store=new Store(':memory:',42),old=initialState();delete old.settings.booking;delete old.waitlist;delete old.expenses;
  store.db.prepare('UPDATE cabinets SET data=? WHERE id=?').run(JSON.stringify(old),42);
  const s=store.read();assert.equal(s.settings.booking.enabled,false);assert.deepEqual(s.waitlist,[]);assert.deepEqual(s.expenses,[]);
  store.close();
});
