import test from 'node:test';
import assert from 'node:assert/strict';
import {startBot,telegram} from '../lib/bot.mjs';
import {Store} from '../lib/store.mjs';
import {localNow} from '../lib/core.mjs';
import {shiftDate} from '../shared.mjs';

// Подменяем Telegram Bot API: getUpdates отдаёт заранее заготовленные апдейты, остальные вызовы записываются.
// refuse(method,body) → true: Telegram отвечает отказом 403, как для чата, который пользователь не открывал.
function fakeTelegram(batches,refuse=()=>false){
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').pop(),body=JSON.parse(init.body||'{}');
    if(method==='getUpdates'){const next=batches.shift();if(!next)await new Promise(r=>setTimeout(r,20));return Response.json({ok:true,result:next||[]})}
    calls.push({method,body});
    if(refuse(method,body))return Response.json({ok:false,error_code:403,description:'Forbidden: bot can\'t initiate conversation with a user'});
    return Response.json({ok:true,result:method==='getMe'?{username:'auto_bot'}:true});
  };
  return {calls,restore:()=>{globalThis.fetch=original}};
}
const msg=(id,from,text)=>({update_id:id,message:{message_id:id,chat:{id:from,type:'private'},from:{id:from},text}});
const press=(id,from,data,messageId)=>({update_id:id,callback_query:{id:'cb'+id,from:{id:from},data,message:{...(messageId?{message_id:messageId}:{}),chat:{id:from,type:'private'}}}});
const until=async(cond,ms=2000)=>{const end=Date.now()+ms;while(!cond()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10))}};
const config=()=>({botToken:'1:x',ownerId:42,publicUrl:'https://smena.test'});
// Адрес уже объявлен: бот стартует без сообщения о новом адресе, и порядок ответов в тестах команд не плавает.
const announced=store=>{store.meta('announcedUrl','https://smena.test');return store};

test('Bot: stranger refused, invite redeemed once, commands answer, menu configured',async()=>{
  const store=announced(new Store(':memory:',42)),code=store.createInvite();
  const today=localNow(store.read().settings.timeZone).date;
  store.mutate(0,s=>{s.records.push({id:'r1',name:'Иван',service:'Мужская стрижка',date:today,time:'23:00',duration:60,status:'confirmed',type:'visit',note:'',phone:'',price:0});return s});
  const tg=fakeTelegram([[msg(1,7,'/today'),msg(2,7,'/start join_'+code),msg(3,8,'/start join_'+code),msg(4,7,'/free'),msg(5,42,'/week'),msg(6,7,'/invite'),
    press(7,42,'tomorrow'), // кнопка под старым сообщением: прежнее значение callback_data
    {update_id:8,message:{chat:{id:-100,type:'group'},from:{id:42},text:'/today'}}]]);
  const cfg=config(),bot=startBot(cfg,store);
  try{
    await until(()=>tg.calls.some(c=>c.method==='setChatMenuButton')&&tg.calls.filter(c=>c.method==='sendMessage').length>=7);
    const sent=tg.calls.filter(c=>c.method==='sendMessage').map(c=>[c.body.chat_id,c.body.text.split('\n')[0]]);
    assert.deepEqual(sent.slice(0,3),[
      [7,'Это личный кабинет барбера. Владелец может выдать вам одноразовое приглашение.'],
      [7,'Доступ к вашей смене открыт. Откройте кабинет кнопкой ниже.'],
      [8,'Приглашение недействительно, уже использовано или истекло. Попросите владельца создать новое.'],
    ]);
    assert.equal(sent[3][0],7);assert.match(sent[3][1],/^<b>Свободные окна: .+<\/b> — сегодня$/);
    assert.equal(sent[4][0],42);assert.match(sent[4][1],/^<b>Неделя: /);
    assert.deepEqual(sent[5],[7,'Приглашения выдаёт хозяин кабинета.']);
    assert.equal(sent[6][0],42);assert.match(sent[6][1],/ — завтра$/);
    assert.equal(store.friend(),7);
    assert.equal(cfg.botUsername,'auto_bot'); // имя бота определено через getMe
    assert.ok(tg.calls.some(c=>c.method==='answerCallbackQuery'));
    assert.ok(!sent.some(([id])=>id===-100)); // групповые чаты игнорируются
    assert.equal(Number(store.meta('offset')),9);
    assert.ok(tg.calls.find(c=>c.method==='setMyCommands').body.commands.some(c=>c.command==='add'));
    await bot.notify('Новая запись в YCLIENTS\n<Иван & Ко>');
    assert.equal(tg.calls.at(-1).body.chat_id,7); // уведомления получает подруга после выдачи доступа
    assert.match(tg.calls.at(-1).body.text,/&lt;Иван &amp; Ко&gt;/); // текст из YCLIENTS не ломает HTML-разметку
  }finally{bot.stop();tg.restore()}
});

test('Bot: /add creates a visit through the same validation, buttons edit the message in place, status is set from chat',async()=>{
  const store=announced(new Store(':memory:',42)),today=localNow(store.read().settings.timeZone).date,day=shiftDate(today,1);
  const batches=[[msg(1,42,`/add ${day.slice(8)}.${day.slice(5,7)}.${day.slice(0,4)} 12:00 Олег <Тест> +7 999 123-45-67`)]],tg=fakeTelegram(batches),bot=startBot(config(),store);
  const of=method=>tg.calls.filter(c=>c.method===method),service=prompt=>prompt.body.reply_markup.inline_keyboard[0][0].callback_data;
  try{
    await until(()=>of('sendMessage').length===1);
    const prompt=of('sendMessage')[0];
    assert.match(prompt.body.text,/Олег &lt;Тест&gt;, \+7 999 123-45-67/);assert.equal(prompt.body.parse_mode,'HTML');
    assert.match(service(prompt),/^a:[\w-]+:0$/);assert.equal(store.read().records.length,0); // до выбора услуги ничего не записано

    batches.push([press(2,42,service(prompt),500)]);
    await until(()=>of('editMessageText').length===1);
    const saved=store.read().records[0];
    assert.deepEqual([saved.name,saved.date,saved.time,saved.duration,saved.service,saved.phone],['Олег <Тест>',day,'12:00',60,'Мужская стрижка','+7 999 123-45-67']);
    assert.equal(of('editMessageText')[0].body.message_id,500);assert.match(of('editMessageText')[0].body.text,/^<b>Записано<\/b>/);

    // Повторное нажатие той же кнопки: черновик уже использован, второй записи не будет.
    batches.push([press(3,42,service(prompt),500)]);
    await until(()=>of('editMessageText').length===2);
    assert.match(of('editMessageText')[1].body.text,/Черновик записи устарел/);assert.equal(store.read().records.length,1);

    // Занятое время: бот отвечает тем же текстом, что и приложение, и предлагает окна.
    batches.push([msg(4,42,'/add завтра 12:30 Пётр')]);
    await until(()=>of('sendMessage').length===2);
    batches.push([press(5,42,service(of('sendMessage')[1]),501)]);
    await until(()=>of('editMessageText').length===3);
    assert.match(of('editMessageText')[2].body.text,/Это время занято/);assert.equal(store.read().records.length,1);
    assert.equal(of('editMessageText')[2].body.reply_markup.inline_keyboard[0][0].callback_data,'f:'+day);

    batches.push([press(6,42,`s:${saved.id}:arrived`,502),press(7,42,'d:'+day,503),press(8,42,'s:missing:done',504),msg(9,42,'/add кривой ввод'),msg(10,42,'Олег')]);
    await until(()=>of('editMessageText').length===5&&of('sendMessage').length===5);
    assert.equal(store.read().records[0].status,'arrived');
    assert.match(of('editMessageText')[3].body.text,/Олег &lt;Тест&gt;<\/b> — пришёл/);
    assert.deepEqual(of('editMessageText')[3].body.reply_markup.inline_keyboard[0].map(b=>b.callback_data),[`s:${saved.id}:done`,`s:${saved.id}:noshow`]);
    assert.equal(of('editMessageText')[4].body.message_id,503);assert.match(of('editMessageText')[4].body.text,/12:00<\/b>–13:00  Олег &lt;Тест&gt; — пришёл/);
    assert.match(of('sendMessage')[2].body.text,/Запись не найдена/);
    assert.match(of('sendMessage')[3].body.text,/Запись из чата/);
    assert.match(of('sendMessage')[4].body.text,/^<b>Олег &lt;Тест&gt;<\/b>/); // имя без команды — поиск клиента
    assert.match(of('sendMessage')[4].body.reply_markup.inline_keyboard[0][0].web_app.url,/^https:\/\/smena\.test\/\?client=/);
  }finally{bot.stop();tg.restore()}
});

test('Bot: a new public address is announced once with a fresh button; a refused chat does not block it',async()=>{
  const store=new Store(':memory:',42);
  store.redeemInvite(store.createInvite(),7);
  store.meta('announcedUrl','https://old-tunnel.test');
  const sends=tg=>tg.calls.filter(c=>c.method==='sendMessage'),menus=tg=>tg.calls.filter(c=>c.method==='setChatMenuButton').length;

  // Адрес сменился: владелец и подруга получают по сообщению с кнопкой на новый адрес.
  let tg=fakeTelegram([]),bot=startBot(config(),store);
  try{
    await until(()=>store.meta('announcedUrl')==='https://smena.test');
    assert.deepEqual(sends(tg).map(c=>c.body.chat_id),[42,7]);
    assert.equal(sends(tg)[0].body.reply_markup.inline_keyboard[0][0].web_app.url,'https://smena.test/');
    assert.match(sends(tg)[0].body.text,/новому адресу/);
  }finally{bot.stop();tg.restore()}

  // Перезапуск с тем же адресом (постоянный домен): молчим.
  tg=fakeTelegram([]);bot=startBot(config(),store);
  try{
    await until(()=>menus(tg)===1);await new Promise(r=>setTimeout(r,50));
    assert.equal(sends(tg).length,0);
  }finally{bot.stop();tg.restore()}

  // Первый запуск, владелец ещё не открывал чат (403): подруге сообщение уходит, настройка не зацикливается.
  store.db.prepare('DELETE FROM meta WHERE key=?').run('announcedUrl');
  tg=fakeTelegram([],(method,body)=>method==='sendMessage'&&body.chat_id===42);bot=startBot(config(),store);
  try{
    await until(()=>store.meta('announcedUrl')==='https://smena.test');
    assert.deepEqual(sends(tg).map(c=>c.body.chat_id),[42,7]);assert.equal(menus(tg),1);
  }finally{bot.stop();tg.restore()}
});

test('Bot API wrapper waits out a 429 and never puts the token into an error',async()=>{
  const original=globalThis.fetch;let n=0;
  globalThis.fetch=async()=>Response.json(++n===1?{ok:false,error_code:429,parameters:{retry_after:0.01}}:n===2?{ok:true,result:'sent'}:{ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'});
  try{
    assert.equal(await telegram({botToken:'1:secret'},'sendMessage',{}),'sent');assert.equal(n,2);
    await assert.rejects(telegram({botToken:'1:secret'},'sendMessage',{}),e=>e.code===403&&!e.message.includes('secret')&&/blocked/.test(e.description));
  }finally{globalThis.fetch=original}
});

test('Bot: each barber sees their own cabinet; reminders go to each cabinet; strangers are sent to YCLIENTS sign-in',async()=>{
  const store=announced(new Store(':memory:',42)),vera=store.createCabinet(500);
  const today=localNow(store.read().settings.timeZone).date;
  vera.mutate(0,s=>{s.records.push({id:'v1',name:'Клиент Веры',service:'Мужская стрижка',date:today,time:'23:30',duration:30,status:'confirmed',type:'visit',note:'',phone:'',price:0});s.settings.morning=false;return s});
  store.mutate(0,s=>{s.settings.morning=false;s.settings.reminders=false;return s});
  vera.mutate(1,s=>{s.settings.reminderMinutes=24*60;return s}); // напоминание сработает сразу
  const tg=fakeTelegram([[msg(1,500,'/today'),msg(2,42,'/today'),msg(3,900,'/today'),msg(4,500,'Клиент Веры')]]);
  const bot=startBot({...config(),yclients:{partnerToken:'p'}},store);
  try{
    await until(()=>tg.calls.filter(c=>c.method==='sendMessage').length>=5);
    const sent=tg.calls.filter(c=>c.method==='sendMessage').map(c=>c.body);
    const to=id=>sent.filter(b=>b.chat_id===id).map(b=>b.text).join('\n---\n');
    assert.match(to(500),/Клиент Веры/);assert.doesNotMatch(to(42),/Клиент Веры/);
    const stranger=sent.find(b=>b.chat_id===900);assert.match(stranger.text,/аккаунтом YCLIENTS/);
    assert.equal(stranger.reply_markup.inline_keyboard.flat().length,1);assert.equal(stranger.reply_markup.inline_keyboard[0][0].web_app.url,'https://smena.test'); // кнопка открытия приложения
    assert.ok(sent.some(b=>b.chat_id===500&&/Клиент Веры/.test(b.text)&&b.text.includes('23:30')&&/мин|ч/.test(b.text))); // напоминание пришло Вере
    await bot.notify('Новая запись',vera);assert.equal(tg.calls.at(-1).body.chat_id,500);
  }finally{bot.stop();tg.restore()}
});
