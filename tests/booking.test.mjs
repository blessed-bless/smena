import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {initialState,localNow,validateBackup,validateSettings,upsertRecord} from '../lib/core.mjs';
import {book,cancelBooking,joinWaitlist,waitingFor,bookingCabinet,keyHash} from '../lib/booking.mjs';
import {bookingSlots,shiftDate} from '../shared.mjs';
import {createApp} from '../server.mjs';
import {startBot} from '../lib/bot.mjs';
import {clientDue} from '../lib/reminders.mjs';

const botToken='123:test';
const signed=(id,first='Пётр')=>{const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:first})});const key=createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));return p.toString()};
// Кабинет с включённой онлайн-записью. Окна считаются от «сейчас» в часовом поясе кабинета, поэтому тесты берут завтрашний день.
function open(store=new Store(':memory:',42)){
  store.mutate(0,s=>({...s,settings:validateSettings({...s.settings,booking:{enabled:true,days:14,notice:120,title:'Вера',note:'Ленина, 5'}})}));
  const slug=store.bookingSlug(),tomorrow=shiftDate(localNow(store.read().settings.timeZone).date,1);
  return {store,slug,tomorrow};
}

test('Booking slots: horizon, notice and busy time are respected',()=>{
  const s=initialState();s.settings.booking={enabled:true,days:3,notice:120,title:'',note:''};
  s.records=[{id:'a',name:'А',service:'x',date:'2026-11-13',time:'10:00',duration:60,status:'confirmed',type:'visit'}];
  const out=bookingSlots(s,60,'2026-11-12','17:10');
  assert.deepEqual(out.map(([d])=>d),['2026-11-13','2026-11-14']); // сегодня после 19:10 окон нет, горизонт — три дня
  assert.equal(out[0][1][0],'11:00');
  assert.equal(bookingSlots(s,60,'2026-11-12','23:30',{days:3,notice:1440})[0][1][0],'10:00'); // за сутки: завтра с 23:30 — значит, послезавтра
  assert.equal(bookingSlots(s,60,'2026-11-12','23:30',{days:3,notice:1440})[0][0],'2026-11-14');
});

test('Booking: a client books a free slot, the same slot cannot be taken twice, limits and phone rules hold',()=>{
  const {store,slug,tomorrow}=open(),db=bookingCabinet(store,slug);
  assert.throws(()=>book(db,{service:0,date:tomorrow,time:'12:00',name:'Иван'}),/телефон/);
  const {record,key}=book(db,{service:0,date:tomorrow,time:'12:00',name:'Иван',phone:'8 900 111-22-33'});
  assert.equal(record.origin,'online');assert.equal(record.cancelKey,keyHash(key));assert.equal(record.status,'confirmed');
  assert.throws(()=>book(db,{service:0,date:tomorrow,time:'12:00',name:'Олег',phone:'+79002223344'}),e=>e.status===409);
  book(db,{service:1,date:tomorrow,time:'15:00',name:'Иван',phone:'+7 900 111 22 33'});
  assert.throws(()=>book(db,{service:0,date:tomorrow,time:'17:00',name:'Иван',phone:'89001112233'}),e=>e.status===429); // две будущие записи — потолок
  // Постоянный клиент записывается под именем из журнала мастера.
  store.mutate(store.read().revision,s=>{upsertRecord(s,{name:'Сергей Ковалёв',phone:'+7 911 000-00-01',service:'Мужская стрижка',duration:60,price:0,date:'2026-01-10',time:'12:00',status:'done',type:'visit'});return s});
  const again=book(db,{service:0,date:tomorrow,time:'17:00',name:'Серёжа',phone:'89110000001'}).record;
  assert.equal(again.name,'Сергей Ковалёв');assert.match(again.note,/Серёжа/);
  // Выключенная запись недоступна, как и неизвестная ссылка.
  assert.throws(()=>bookingCabinet(store,'xxxxxxxxxxxx'),e=>e.status===404);
  store.mutate(store.read().revision,s=>({...s,settings:{...s.settings,booking:{...s.settings.booking,enabled:false}}}));
  assert.throws(()=>bookingCabinet(store,slug),e=>e.status===404);
});

test('Booking: cancel by key or by Telegram owner only, online fields survive edits and backups',()=>{
  const {store,slug,tomorrow}=open(),db=bookingCabinet(store,slug);
  const {record,key}=book(db,{service:0,date:tomorrow,time:'12:00',name:'Пётр'},{clientTg:777});
  assert.throws(()=>cancelBooking(db,r=>r.id===record.id&&r.clientTg===778),e=>e.status===404); // чужая кнопка
  // Мастер перенёс запись — привязка к клиенту и ключ отмены остаются.
  store.mutate(store.read().revision,s=>{upsertRecord(s,{...s.records.find(r=>r.id===record.id),time:'13:00'});return s});
  const moved=store.read().records.find(r=>r.id===record.id);
  assert.deepEqual([moved.origin,moved.clientTg,moved.cancelKey],['online',777,keyHash(key)]);
  const copy=validateBackup({format:'smena-v2',...store.read()});
  assert.equal(copy.records[0].clientTg,777);
  // Копия из файла не приносит Telegram ID, которых нет в кабинете: бот не будет писать посторонним.
  const forged=validateBackup({format:'smena-v2',...store.read(),records:store.read().records.map(r=>({...r,clientTg:555}))},new Set([777]));
  assert.equal(forged.records[0].clientTg,undefined);assert.equal(validateBackup({format:'smena-v2',...store.read()},new Set([777])).records[0].clientTg,777);
  const h=keyHash(key);assert.equal(cancelBooking(db,r=>r.cancelKey===h).status,'cancelled');
  assert.throws(()=>cancelBooking(db,r=>r.cancelKey===h),/нельзя/);
});

test('Waitlist: one entry per client, matching service first, kept in backups; expenses validated',()=>{
  const {store,slug}=open(),db=bookingCabinet(store,slug);
  assert.throws(()=>joinWaitlist(db,{name:'Аня',service:0}),/телефон/);
  joinWaitlist(db,{name:'Аня',phone:'89000000001',service:1,note:'после 18'});
  joinWaitlist(db,{name:'Боря'},{clientTg:55});
  assert.throws(()=>joinWaitlist(db,{name:'Аня 2',phone:'+7 900 000-00-01'}),e=>e.status===409);
  const state=store.read();
  assert.deepEqual(waitingFor(state,{service:'Стрижка и борода'}).map(w=>w.name),['Аня','Боря']);
  assert.deepEqual(waitingFor(state,{service:'Мужская стрижка'}).map(w=>w.name),['Аня','Боря']); // равные — по давности
  // Клиент из листа ожидания записался сам — из списка он уходит.
  const day=bookingSlots(state,60,localNow(state.settings.timeZone).date,localNow(state.settings.timeZone).time)[1];
  book(db,{service:0,date:day[0],time:day[1][0],name:'Аня',phone:'89000000001'});
  assert.deepEqual(store.read().waitlist.map(w=>w.name),['Боря']);
  const copy=validateBackup({format:'smena-v2',...state,expenses:[{id:'e1',date:'2026-11-01',amount:15000,kind:'Аренда',note:''}]});
  assert.equal(copy.waitlist.length,2);assert.equal(copy.waitlist[1].clientTg,55);assert.equal(copy.expenses[0].amount,15000);
  assert.throws(()=>validateBackup({format:'smena-v2',...state,expenses:[{date:'2026-11-01',amount:-5,kind:'Аренда'}]}),/Сумма/);
  // Копии до 0.7: без листа ожидания, расходов и настроек записи.
  const {booking,...old}=state.settings;const legacy=validateBackup({format:'smena-v2',records:[],settings:old});
  assert.deepEqual([legacy.waitlist,legacy.expenses,legacy.settings.booking.enabled],[[],[],false]);
});

test('HTTP: booking page API, master links, events for the bot, waitlist and expenses',async()=>{
  const store=new Store(':memory:',42),events=[],files=[],config={botToken,botUsername:'smena_bot',ownerId:42,port:0,publicUrl:'https://smena.test'};
  const probe=createApp(config,store);await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port,base='http://127.0.0.1:'+port;await new Promise(r=>probe.close(r));
  config.port=port;config.publicUrl=base;
  const app=createApp(config,store,null,undefined,undefined,(name,db,record,by)=>{if(name==='file'){files.push(record);return record.to===42}events.push([name,db.cabinet,record?.name,by])});await new Promise(r=>app.listen(port,'127.0.0.1',r));
  const session=store.createSession(42);
  const post=(path,body,token)=>fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',origin:base,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const get=(path,token)=>fetch(base+'/api/'+path,token?{headers:{authorization:'Bearer '+token}}:{});
  try{
    let state=await (await get('state',session)).json();assert.equal(state.booking,null);
    const saved=await post('settings',{revision:state.revision,settings:{...state.settings,booking:{enabled:true,days:14,notice:120,title:'Вера',note:''}}},session);assert.equal(saved.status,200);
    state=await (await get('state',session)).json();
    const slug=state.booking.slug;assert.equal(state.booking.telegram,'https://t.me/smena_bot?start=book_'+slug);assert.equal(state.booking.web,base+'/book?c='+slug);
    const info=await (await get('book/info?c='+slug)).json();assert.equal(info.title,'Вера');assert.equal(info.services.length,3);
    assert.equal((await get('book/info?c=nope')).status,404);
    assert.equal((await fetch(base+'/book')).status,200);
    const slots=(await (await get('book/slots?c='+slug+'&s=0')).json()).slots,[date,times]=slots.find(([d])=>d>state.today);
    assert.equal((await post('book',{c:slug,service:0,date,time:times[0],name:'Бот',phone:'89000000000',website:'x'})).status,400); // ловушка
    const web=await (await post('book',{c:slug,service:0,date,time:times[0],name:'Иван',phone:'89000000000'})).json();
    assert.equal(web.ok,true);assert.equal(web.telegram,false);
    const tg=await (await post('book',{c:slug,service:0,date,time:times[2],initData:signed(901,'Пётр')})).json();assert.equal(tg.telegram,true);
    assert.equal(store.read().records.find(r=>r.clientTg===901).name,'Пётр'); // имя взято из Telegram
    assert.equal((await post('book',{c:slug,service:0,date,time:times[2],name:'Ещё',phone:'89001111111'})).status,409);
    assert.equal((await post('book/cancel',{c:slug,key:'wrong-key-123'})).status,404);
    assert.equal((await post('book/cancel',{c:slug,key:web.key})).status,200);
    assert.equal((await post('book/wait',{c:slug,name:'Аня',phone:'89000000009',service:0,note:'вечером'})).status,200);
    // Мастер отменяет запись Петра в приложении — бот должен написать клиенту.
    state=await (await get('state',session)).json();const petr=state.records.find(r=>r.clientTg===901);
    assert.equal((await post('cancel',{revision:state.revision,id:petr.id},session)).status,200);
    assert.deepEqual(events.map(e=>e[0]+':'+(e[3]||'')),['booked:','booked:','cancelled:client','waiting:','cancelled:master']);
    // Лист ожидания и расходы.
    state=await (await get('state',session)).json();const w=state.waitlist[0];
    let next=await (await post('waitlist',{revision:state.revision,entry:{...w,note:'после 18'}},session)).json();assert.equal(next.waitlist[0].note,'после 18');assert.equal(next.waitlist[0].origin,'online');
    next=await (await post('waitlist',{revision:next.revision,remove:w.id},session)).json();assert.equal(next.waitlist.length,0);
    next=await (await post('expense',{revision:next.revision,expense:{date:state.today,amount:3000,kind:'Материалы',note:'краска'}},session)).json();assert.equal(next.expenses[0].amount,3000);
    assert.equal((await post('expense',{revision:next.revision,expense:{date:state.today,amount:0,kind:'Материалы'}},session)).status,400);
    next=await (await post('expense',{revision:next.revision,remove:next.expenses[0].id},session)).json();assert.equal(next.expenses.length,0);
    // Файлы в чат: таблица клиентов уходит через бота; неизвестный файл — ошибка.
    assert.equal((await post('send-file',{kind:'clients'},session)).status,200);
    assert.match(files[0].name,/^smena-klienty-.*\.csv$/);assert.equal(files[0].to,42);assert.match(files[0].content,/"Клиент";"Телефон"/);
    assert.equal((await post('send-file',{kind:'passwords'},session)).status,400);
    // Новая ссылка: старая перестаёт работать.
    const fresh=(await (await post('booking-reset',{},session)).json()).booking;assert.notEqual(fresh.slug,slug);
    assert.equal((await get('book/info?c='+slug)).status,404);assert.equal((await get('book/info?c='+fresh.slug)).status,200);
  }finally{await new Promise(r=>app.close(r))}
});

// Подменённый Telegram Bot API, как в bot.test.mjs.
function fakeTelegram(batches,refuse=()=>false){
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').pop(),body=init.body instanceof FormData?Object.fromEntries(init.body):JSON.parse(init.body||'{}');
    if(method==='getUpdates'){const next=batches.shift();if(!next)await new Promise(r=>setTimeout(r,20));return Response.json({ok:true,result:next||[]})}
    calls.push({method,body});
    if(refuse(method,body))return Response.json({ok:false,error_code:403,description:'Forbidden'});
    return Response.json({ok:true,result:method==='getMe'?{username:'auto_bot'}:true});
  };
  return {calls,restore:()=>{globalThis.fetch=original}};
}
const msg=(id,from,text)=>({update_id:id,message:{message_id:id,chat:{id:from,type:'private'},from:{id:from},text}});
const press=(id,from,data)=>({update_id:id,callback_query:{id:'cb'+id,from:{id:from},data,message:{chat:{id:from,type:'private'}}}});
const until=async(cond,ms=3000)=>{const end=Date.now()+ms;while(!cond()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10))}};

test('Bot: booking link, messages to master and client, client cancel, master cancel with waitlist offer, reminders',async()=>{
  const {store,slug,tomorrow}=open();store.meta('announcedUrl','https://smena.test');
  const db=bookingCabinet(store,slug);
  joinWaitlist(db,{name:'Боря Ждун'},{clientTg:55});
  const a=book(db,{service:0,date:tomorrow,time:'12:00',name:'Пётр'},{clientTg:777}).record;
  const b=book(db,{service:0,date:tomorrow,time:'15:00',name:'Лиза'},{clientTg:888}).record;
  const tg=fakeTelegram([[msg(1,900,'/start book_'+slug),msg(2,900,'/start book_badbadbadbad'),press(3,999,`bc:42:${a.id}`),press(4,777,`bc:42:${a.id}`)]]);
  const bot=startBot({botToken,ownerId:42,publicUrl:'https://smena.test',botUsername:'smena_bot'},store);
  const texts=()=>tg.calls.filter(c=>['sendMessage','editMessageText'].includes(c.method)).map(c=>[c.body.chat_id,c.body.text,c.body.reply_markup]);
  try{
    await until(()=>texts().filter(([id])=>id===42).length>=1&&texts().some(([id])=>id===777));
    const start=texts().find(([id])=>id===900);
    assert.match(start[1],/Запись: Вера/);assert.match(start[1],/Ленина, 5/);
    assert.equal(start[2].inline_keyboard[0][0].web_app.url,'https://smena.test/book?c='+slug);
    assert.ok(texts().some(([id,t])=>id===900&&/выключена/.test(t)));
    assert.ok(texts().some(([id,t])=>id===999&&/не найдена/.test(t))); // чужая кнопка отмены
    assert.equal(store.read().records.find(r=>r.id===a.id).status,'cancelled');
    const master=texts().find(([id,t])=>id===42&&/Клиент отменил запись/.test(t));
    assert.match(master[1],/Боря Ждун/);assert.equal(master[2].inline_keyboard[0][0].callback_data,`wo:${store.read().waitlist[0].id}:${tomorrow}:12:00`);
    // Сообщения о новой записи — через события сервера.
    await bot.events('booked',db,b);
    assert.ok(texts().some(([id,t,k])=>id===42&&/Новая онлайн-запись/.test(t)&&k.inline_keyboard[0][0].callback_data==='x:'+b.id));
    assert.ok(texts().some(([id,t,k])=>id===888&&/Вы записаны/.test(t)&&k.inline_keyboard[0][0].callback_data===`bc:42:${b.id}`));
    // Мастер отменяет из чата с подтверждением, клиент получает сообщение, мастеру предлагают лист ожидания.
    await bot.handle(press(10,42,'x:'+b.id));assert.ok(texts().some(([id,t])=>id===42&&/Отменить запись <b>Лиза/.test(t)));
    await bot.handle(press(11,42,'xx:'+b.id));
    assert.equal(store.read().records.find(r=>r.id===b.id).status,'cancelled');
    assert.ok(texts().some(([id,t,k])=>id===888&&/Мастер отменил вашу запись/.test(t)&&k.inline_keyboard[0][0].web_app.url.includes(slug)));
    // Предложение окна клиенту из листа ожидания.
    await bot.handle(press(12,42,`wo:${store.read().waitlist[0].id}:${tomorrow}:15:00`));
    const offer=texts().find(([id,t])=>id===55&&/Освободилось время/.test(t));
    assert.match(offer[2].inline_keyboard[0][0].web_app.url,new RegExp(`d=${tomorrow}&t=15%3A00`));
    assert.ok(texts().some(([id,t])=>id===42&&/Предложение отправлено/.test(t)));
    // Файл в чат уходит через sendDocument с вложением.
    assert.equal(await bot.events('file',db,{to:42,name:'smena.csv',caption:'Записи',content:'a;b'}),true);
    const doc=tg.calls.find(c=>c.method==='sendDocument').body;
    assert.equal(doc.chat_id,'42');assert.equal(doc.document.name,'smena.csv');assert.equal(await doc.document.text(),'a;b');
  }finally{bot.stop();tg.restore()}
  // Напоминание клиенту: за сутки и только по активной онлайн-записи из Telegram.
  const s=store.read(),c={...a,status:'confirmed',clientTg:5};
  assert.equal(clientDue({...s,records:[c]},{date:tomorrow,time:'09:00'}).length,1);
  assert.equal(clientDue({...s,records:[c]},{date:shiftDate(tomorrow,-2),time:'09:00'}).length,0);
  assert.equal(clientDue({...s,records:[{...c,origin:undefined}]},{date:tomorrow,time:'09:00'}).length,0);
});

test('HTTP: behind a proxy the limit counts the address the proxy added, not a spoofed first one',async()=>{
  const {store,slug,tomorrow}=open(),config={botToken,ownerId:42,port:0,trustProxy:true};
  const probe=createApp(config,store);await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port,base='http://127.0.0.1:'+port;await new Promise(r=>probe.close(r));
  config.port=port;const app=createApp(config,store);await new Promise(r=>app.listen(port,'127.0.0.1',r));
  try{
    const codes=[];
    for(let i=0;i<9;i++)codes.push((await fetch(base+'/api/book',{method:'POST',headers:{'content-type':'application/json',origin:base,'x-forwarded-for':`10.0.0.${i}, 203.0.113.7`},body:JSON.stringify({c:slug,service:0,date:tomorrow,time:'03:00',name:'Спам',phone:'89000000000'})})).status);
    assert.deepEqual(codes,[409,409,409,409,409,409,409,409,429]); // время невалидно, но попытки считаются по 203.0.113.7
    const other=await fetch(base+'/api/book',{method:'POST',headers:{'content-type':'application/json',origin:base,'cf-connecting-ip':'198.51.100.1'},body:JSON.stringify({c:slug,service:0,date:tomorrow,time:'03:00',name:'Другой',phone:'89000000001'})});
    assert.equal(other.status,409);
  }finally{await new Promise(r=>app.close(r))}
});
