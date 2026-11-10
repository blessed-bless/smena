// Telegram-бот «Смены»: long polling, команды, кнопки и напоминания.
// Тексты и клавиатуры собирает views.mjs; здесь только транспорт, доступ и маршрутизация.
import {randomBytes} from 'node:crypto';
import {localNow,AppError,upsertRecord} from './core.mjs';
import {sendNotifications} from './reminders.mjs';
import {freeGaps,hhmm,mins} from '../shared.mjs';
import {esc,launchKeyboard,dayView,freeView,weekView,nextView,findView,statsView,statusView,parseDay,parseAdd,addPrompt,addedView,ADD_HELP,HELP} from './views.mjs';

const DRAFT_TTL=10*60*1000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function freeWindows(state,date,now){
  const gaps=freeGaps(state,date,Math.ceil(mins(now)/15)*15);
  return gaps&&gaps.map(([start,end])=>hhmm(start)+'–'+hhmm(end));
}

// Вызов Bot API. Если Telegram просит подождать (429), ждём указанное время и повторяем — до двух раз.
export async function telegram(config,method,payload={},attempt=0){
  const response=await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(35000)});
  const data=await response.json().catch(()=>({}));
  if(data.ok)return data.result;
  const wait=Number(data.parameters?.retry_after);
  if(data.error_code===429&&attempt<2&&wait>0&&wait<=10){await sleep(wait*1000);return telegram(config,method,payload,attempt+1)}
  // В тексте ошибки нет токена: только метод и код ответа.
  throw Object.assign(Error(`Telegram ${method}: ${data.error_code||response.status}`),{code:data.error_code||response.status,description:String(data.description||'')});
}

const COMMANDS=[
  ['start','Открыть личный кабинет'],['today','План на сегодня'],['tomorrow','План на завтра'],['week','Неделя по дням'],
  ['free','Свободные окна'],['next','Ближайший клиент'],['add','Записать клиента из чата'],['find','Найти клиента'],
  ['stats','Итоги недели'],['invite','Пригласить подругу (для владельца)'],['help','Возможности и помощь']
];
export async function configureBot(config){
  if(!config.botUsername){const me=await telegram(config,'getMe');config.botUsername=me.username}
  await telegram(config,'setMyCommands',{commands:COMMANDS.map(([command,description])=>({command,description}))});
  await telegram(config,'setMyDescription',{description:'Смена — личный кабинет барбера в Telegram. Расписание, свободные окна, клиенты и напоминания. Записи YCLIENTS подтягиваются автоматически, если подключён календарь. Вход только по разрешению владельца.'});
  await telegram(config,'setMyShortDescription',{short_description:'Личный кабинет барбера: расписание, клиенты и напоминания. Доступ по приглашению.'});
  await telegram(config,'setChatMenuButton',{menu_button:{type:'web_app',text:'Моя смена',web_app:{url:config.publicUrl}}});
}

export function startBot(config,store){
  let stopped=false,busy=false,pollError='';
  const abort=new AbortController(),url=config.publicUrl,owner=Number(config.ownerId),launch=launchKeyboard(url),none={inline_keyboard:[]};
  const drafts=new Map(); // черновики /add между командой и выбором услуги: id -> {userId, date, time, name, phone, services, at}
  const message=(id,text,keyboard)=>({chat_id:id,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:keyboard});
  const send=(id,text,keyboard=launch)=>telegram(config,'sendMessage',message(id,text,keyboard));
  // Ответ на нажатие кнопки правит то же сообщение, чтобы чат не зарастал копиями плана.
  // Если сообщение изменить уже нельзя (слишком старое), ответ приходит новым сообщением.
  async function reply(ctx,view){
    const keyboard=view.keyboard||launch;
    if(ctx.messageId){
      try{await telegram(config,'editMessageText',{...message(ctx.userId,view.text,keyboard),message_id:ctx.messageId});return}
      catch(e){if(/not modified/i.test(e.description||''))return}
    }
    await send(ctx.userId,view.text,keyboard);
  }
  const now=()=>localNow(store.read().settings.timeZone);

  function setStatus(ctx,id,status){
    if(!['arrived','done','noshow'].includes(status))return;
    try{
      let saved;
      store.mutate(store.read().revision,state=>{
        const old=state.records.find(r=>r.id===id);
        if(!old)throw new AppError('NOT_FOUND','Запись не найдена: возможно, её уже удалили.',404);
        saved=upsertRecord(state,{...old,status});
        return state;
      },'Статус визита из чата');
      return reply(ctx,statusView(saved,url));
    }catch(e){
      if(!(e instanceof AppError))throw e;
      return send(ctx.userId,esc(e.message)); // напоминание не трогаем: ошибка приходит отдельным сообщением
    }
  }

  function startAdd(ctx,args,state,today){
    const parsed=parseAdd(args,today);
    if(!parsed)return send(ctx.userId,ADD_HELP,none);
    for(const [id,d] of drafts)if(Date.now()-d.at>DRAFT_TTL||drafts.size>50)drafts.delete(id);
    const draft={id:randomBytes(6).toString('base64url'),userId:ctx.userId,...parsed,services:state.settings.services.map(s=>s.name),at:Date.now()};
    drafts.set(draft.id,draft);
    const view=addPrompt(draft,state.settings.services,today);
    return send(ctx.userId,view.text,view.keyboard);
  }
  function finishAdd(ctx,id,choice){
    const draft=drafts.get(id);
    if(!draft||draft.userId!==ctx.userId||Date.now()-draft.at>DRAFT_TTL)return reply(ctx,{text:'Черновик записи устарел. Отправьте /add ещё раз.',keyboard:none});
    drafts.delete(id);
    if(choice==='x')return reply(ctx,{text:'Запись не создана.'});
    try{
      let saved;
      // Та же проверка, что и в приложении: рабочее время, пересечения, записи YCLIENTS.
      store.mutate(store.read().revision,state=>{
        const service=state.settings.services.find(s=>s.name===draft.services[Number(choice)]);
        if(!service)throw new AppError('INVALID','Этой услуги больше нет в списке. Отправьте /add ещё раз.');
        saved=upsertRecord(state,{name:draft.name,phone:draft.phone,service:service.name,duration:service.duration,price:service.price,date:draft.date,time:draft.time,status:'confirmed',type:'visit',note:''});
        return state;
      },'Запись из чата');
      return reply(ctx,addedView(saved,url));
    }catch(e){
      if(!(e instanceof AppError))throw e;
      return reply(ctx,{text:`${esc(e.message)}\n\n${esc(draft.name)}, ${draft.time} — запись не создана.`,keyboard:{inline_keyboard:[[{text:'Свободные окна',callback_data:'f:'+draft.date},{text:'План дня',callback_data:'d:'+draft.date}]]}});
    }
  }

  // Ключи маршрутов общие для команд и кнопок: d — день, f — окна, w — неделя, n — ближайший, st — итоги, s — статус, a — запись.
  function route(ctx,key){
    const state=store.read(),time=now(),today=time.date,[kind,a,b]=key.split(':');
    if(kind==='d')return reply(ctx,dayView(state,parseDay(a,today)||today,today,url));
    if(kind==='f')return reply(ctx,freeView(state,parseDay(a,today)||today,today,time.time,url));
    if(kind==='w')return reply(ctx,weekView(state,today,url));
    if(kind==='n')return reply(ctx,nextView(state,time,url));
    if(kind==='st')return reply(ctx,statsView(state,today,url));
    if(kind==='s')return setStatus(ctx,a,b);
    if(kind==='a')return finishAdd(ctx,a,b);
  }

  async function handle(update){
    const callback=update.callback_query,incoming=update.message||callback?.message,user=callback?.from||incoming?.from;
    if(!user||incoming?.chat?.type!=='private')return;
    if(callback)await telegram(config,'answerCallbackQuery',{callback_query_id:callback.id}).catch(()=>{});
    const text=callback?'':String(incoming.text||'').trim(),[command='',param='']=text.split(/\s+/),cmd=command.split('@')[0].toLowerCase(),args=text.slice(command.length).trim();
    const ctx={userId:user.id,messageId:callback?incoming.message_id:null};
    if(cmd==='/start'&&param.startsWith('join_')&&!store.allowed(user.id)){
      if(!store.redeemInvite(param.slice(5),user.id)){await send(user.id,'Приглашение недействительно, уже использовано или истекло. Попросите владельца создать новое.',none);return}
      await send(user.id,'Доступ к вашей смене открыт. Откройте кабинет кнопкой ниже.');return;
    }
    if(!store.allowed(user.id)){await send(user.id,'Это личный кабинет барбера. Владелец может выдать вам одноразовое приглашение.',none);return}
    if(callback){
      // Кнопки под старыми сообщениями присылают прежние значения — они продолжают работать.
      const legacy={today:'d:today',tomorrow:'d:tomorrow',free:'f:today'},data=String(callback.data||'');
      await route(ctx,legacy[data]||data);return;
    }
    if(cmd==='/invite'){
      if(user.id!==owner){await send(user.id,'Приглашения выдаёт владелец бота.');return}
      if(store.friend()!==null){await send(user.id,'Доступ подруге уже выдан. Управление доступом — в настройках приложения.');return}
      await send(user.id,`Приглашение для подруги:\nhttps://t.me/${config.botUsername}?start=join_${store.createInvite()}\n\nРаботает один раз в течение 24 часов. Перешлите только ей. Новое приглашение отменяет предыдущее.`,none);return;
    }
    const today=now().date;
    if(cmd==='/today'||cmd==='/tomorrow'){await route(ctx,'d:'+cmd.slice(1));return}
    if(cmd==='/day'||cmd==='/free'){
      const date=parseDay(param,today);
      if(!date){await send(user.id,`Не понял день. Примеры: <code>${cmd} завтра</code>, <code>${cmd} 14.11</code>`,none);return}
      await route(ctx,(cmd==='/day'?'d:':'f:')+date);return;
    }
    if(cmd==='/week'){await route(ctx,'w');return}
    if(cmd==='/next'){await route(ctx,'n');return}
    if(cmd==='/stats'){await route(ctx,'st');return}
    if(cmd==='/add'){await startAdd(ctx,args,store.read(),today);return}
    if(cmd==='/find'){const view=findView(store.read(),args,today,url);await send(user.id,view.text,view.keyboard);return}
    if(cmd==='/help'){await send(user.id,HELP);return}
    // Обычный текст — поиск клиента: имя или телефон без команды.
    if(text&&!text.startsWith('/')&&text.length>=2&&text.length<=80){
      const view=findView(store.read(),text,today,url);
      if(view.count){await send(user.id,view.text,view.keyboard);return}
      await send(user.id,view.text+'\n\nЗаписать нового клиента: <code>/add завтра 15:30 '+esc(text)+'</code>');return;
    }
    await send(user.id,cmd==='/start'||!cmd?'Ваша смена — под рукой. Откройте кабинет или посмотрите план прямо здесь.':'Такой команды нет. Список возможностей — /help');
  }

  function pause(){return new Promise(resolve=>{const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,5000);abort.signal.addEventListener('abort',done,{once:true})})}
  async function poll(){
    let offset=Number(store.meta('offset')||0);
    while(!stopped){
      try{
        const updates=await telegram(config,'getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
        pollError='';
        for(const update of updates){
          try{await handle(update)}
          catch(e){console.error('Bot update failed:',e?.code?e.message:e?.name||'error')}
          offset=update.update_id+1;store.meta('offset',offset);
        }
      }catch(e){
        if(stopped)break;
        // Одну и ту же причину пишем в лог один раз, а не каждые пять секунд.
        const reason=e?.code===409?'another process is polling this bot token':e?.code===401?'bot token rejected':e?.code?e.message:'network error';
        if(reason!==pollError){pollError=reason;console.error('Bot polling paused:',reason)}
        await pause();
      }
    }
  }
  async function notify(){
    if(busy||stopped)return;
    busy=true;
    try{await sendNotifications({config,store,send:(id,text,keyboard)=>send(id,text,keyboard||launch),now:now()})}
    finally{busy=false}
  }
  // Временный туннель при каждом запуске даёт новый адрес, а кнопки под прежними сообщениями хранят старый.
  // Поэтому при смене адреса бот один раз присылает свежую кнопку всем, у кого есть доступ.
  async function announce(){
    if(store.meta('announcedUrl')===url)return;
    for(const id of [owner,store.friend()].filter(Boolean)){
      try{await send(id,'<b>Смена запущена по новому адресу.</b>\nКнопки под прежними сообщениями могут не открываться — заходите в кабинет отсюда.')}
      catch(e){if(!e?.code)throw e} // отказ Telegram (чат не начат, бот заблокирован) окончательный; сетевую ошибку повторит цикл ниже
    }
    store.meta('announcedUrl',url);
  }
  poll();notify().catch(()=>{});
  (async()=>{while(!stopped){try{await configureBot(config);await announce();console.log('Telegram menu configured.');break}catch{console.error('Telegram menu setup will retry.');await pause()}}})();
  const timer=setInterval(()=>notify().catch(()=>{}),30000);timer.unref();
  // Уведомления синхронизации приходят обычным текстом, поэтому экранируются целиком.
  return {stop(){stopped=true;abort.abort();clearInterval(timer)},notify:text=>send(store.friend()||owner,esc(text))};
}
