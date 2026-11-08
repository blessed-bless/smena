import test from 'node:test';
import assert from 'node:assert/strict';
import {startBot} from '../lib/bot.mjs';
import {Store} from '../lib/store.mjs';
import {localNow} from '../lib/core.mjs';

// Подменяем Telegram Bot API: getUpdates отдаёт заранее заготовленные апдейты, остальные вызовы записываются.
function fakeTelegram(batches){
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').pop(),body=JSON.parse(init.body||'{}');
    if(method==='getUpdates'){const next=batches.shift();if(!next)await new Promise(r=>setTimeout(r,50));return Response.json({ok:true,result:next||[]})}
    calls.push({method,body});
    return Response.json({ok:true,result:method==='getMe'?{username:'auto_bot'}:true});
  };
  return {calls,restore:()=>{globalThis.fetch=original}};
}
const msg=(id,from,text)=>({update_id:id,message:{message_id:id,chat:{id:from,type:'private'},from:{id:from},text}});
const until=async(cond,ms=2000)=>{const end=Date.now()+ms;while(!cond()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,20))}};

test('Bot: stranger refused, invite redeemed once, commands answer, menu configured',async()=>{
  const store=new Store(':memory:',42),code=store.createInvite();
  const today=localNow(store.read().settings.timeZone).date;
  store.mutate(0,s=>{s.records.push({id:'r1',name:'Иван',service:'Мужская стрижка',date:today,time:'23:00',duration:60,status:'confirmed',type:'visit',note:'',phone:'',price:0});return s});
  const tg=fakeTelegram([[msg(1,7,'/today'),msg(2,7,'/start join_'+code),msg(3,8,'/start join_'+code),msg(4,7,'/free'),msg(5,42,'/week'),msg(6,7,'/invite'),
    {update_id:7,callback_query:{id:'cb',from:{id:42},data:'tomorrow',message:{chat:{id:42,type:'private'}}}},
    {update_id:8,message:{chat:{id:-100,type:'group'},from:{id:42},text:'/today'}}]]);
  const config={botToken:'1:x',ownerId:42,publicUrl:'https://smena.test'};
  const bot=startBot(config,store);
  try{
    await until(()=>tg.calls.some(c=>c.method==='setChatMenuButton')&&tg.calls.filter(c=>c.method==='sendMessage').length>=7);
    const sent=tg.calls.filter(c=>c.method==='sendMessage').map(c=>[c.body.chat_id,c.body.text.split('\n')[0]]);
    assert.deepEqual(sent.slice(0,7),[
      [7,'Это личный кабинет барбера. Владелец может выдать вам одноразовое приглашение.'],
      [7,'Доступ к вашей смене открыт. Откройте кабинет кнопкой ниже.'],
      [8,'Приглашение недействительно, уже использовано или истекло. Попросите владельца создать новое.'],
      [7,sent[3][1]],
      [42,'План на 7 дней'],
      [7,'Приглашения выдаёт владелец бота.'],
      [42,'Ваш план на '+(()=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10).split('-').reverse().join('.')})()],
    ]);
    assert.match(sent[3][1],/^(Свободно сегодня:|Сегодня свободных окон больше нет\.|Сегодня выходной)/);
    assert.equal(store.friend(),7);
    assert.equal(config.botUsername,'auto_bot'); // имя бота определено через getMe
    assert.ok(tg.calls.some(c=>c.method==='answerCallbackQuery'));
    assert.ok(!sent.some(([id])=>id===-100)); // групповые чаты игнорируются
    assert.equal(Number(store.meta('offset')),9);
    await bot.notify('Новая запись в YCLIENTS');
    assert.equal(tg.calls.at(-1).body.chat_id,7); // уведомления получает подруга после выдачи доступа
  }finally{bot.stop();tg.restore()}
});
