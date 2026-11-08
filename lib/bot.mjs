import {localNow,active} from './core.mjs';
import {summaryForDay,sendNotifications,footer} from './reminders.mjs';
import {workday} from '../shared.mjs';
export function freeWindows(state,date,now){
  const h=workday(state,date);if(h.closed)return null;
  const m=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),f=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  let cursor=Math.max(m(h.start),Math.ceil(m(now)/15)*15);const out=[];
  for(const r of state.records.filter(r=>r.date===date&&active(r)).sort((a,b)=>a.time.localeCompare(b.time))){const s=m(r.time);if(Math.min(s,m(h.end))-cursor>=15)out.push(f(cursor)+'–'+f(Math.min(s,m(h.end))));cursor=Math.max(cursor,s+r.duration)}
  if(m(h.end)-cursor>=15)out.push(f(cursor)+'–'+h.end);
  return out;
}

export async function telegram(config,method,payload={}){
  const response=await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(35000)});
  const data=await response.json();if(!data.ok)throw Error(`Telegram ${method}: ${data.error_code||response.status}`);return data.result;
}
function overview(state,date){return summaryForDay(state,date)}
export async function configureBot(config){
  if(!config.botUsername){const me=await telegram(config,'getMe');config.botUsername=me.username}
  await telegram(config,'setMyCommands',{commands:[{command:'start',description:'Открыть личный кабинет'},{command:'today',description:'План на сегодня'},{command:'tomorrow',description:'План на завтра'},{command:'week',description:'План на 7 дней'},{command:'free',description:'Свободные окна на сегодня'},{command:'invite',description:'Пригласить второго пользователя (для владельца)'},{command:'help',description:'Возможности и помощь'}]});
  await telegram(config,'setMyDescription',{description:'Смена — личный кабинет барбера в Telegram. Расписание, свободные окна, клиенты и напоминания. Записи YCLIENTS подтягиваются автоматически, если подключён календарь. Вход только по разрешению владельца.'});
  await telegram(config,'setMyShortDescription',{short_description:'Личный кабинет барбера: расписание, клиенты и напоминания. Доступ по приглашению.'});
  await telegram(config,'setChatMenuButton',{menu_button:{type:'web_app',text:'Моя смена',web_app:{url:config.publicUrl}}});
}
export function startBot(config,store){
  let stopped=false,busy=false;const abort=new AbortController();
  const launch={inline_keyboard:[[{text:'Открыть мою смену',web_app:{url:config.publicUrl}}],[{text:'Сегодня',callback_data:'today'},{text:'Завтра',callback_data:'tomorrow'},{text:'Окна',callback_data:'free'}]]};
  const send=(id,text,buttons=launch)=>telegram(config,'sendMessage',{chat_id:id,text,reply_markup:buttons});
  const datePlus=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
  async function handle(update){
    const callback=update.callback_query,message=update.message||callback?.message,user=callback?.from||message?.from;
    if(!user||message?.chat?.type!=='private')return;
    if(callback)await telegram(config,'answerCallbackQuery',{callback_query_id:callback.id}).catch(()=>{});
    const text=callback?'/'+callback.data:String(message.text||''),[command,param]=text.trim().split(/\s+/),cmd=command.split('@')[0];
    if(cmd==='/start'&&param?.startsWith('join_')&&!store.allowed(user.id)){
      if(!store.redeemInvite(param.slice(5),user.id)){await send(user.id,'Приглашение недействительно, уже использовано или истекло. Попросите владельца создать новое.',{inline_keyboard:[]});return}
      await send(user.id,'Доступ к вашей смене открыт. Откройте кабинет кнопкой ниже.');return;
    }
    if(!store.allowed(user.id)){await send(user.id,'Это личный кабинет барбера. Владелец может выдать вам одноразовое приглашение.',{inline_keyboard:[]});return}
    if(cmd==='/invite'){
      if(user.id!==Number(config.ownerId)){await send(user.id,'Приглашения выдаёт владелец бота.');return}
      if(store.friend()!==null){await send(user.id,'Доступ второму пользователю уже выдан. Управление доступом — в настройках приложения.');return}
      await send(user.id,`Приглашение для второго пользователя:\nhttps://t.me/${config.botUsername}?start=join_${store.createInvite()}\n\nРаботает один раз в течение 24 часов. Перешлите только ей. Новое приглашение отменяет предыдущее.`,{inline_keyboard:[]});return;
    }
    const state=store.read(),today=localNow(state.settings.timeZone).date;
    if(cmd==='/today'||cmd==='/tomorrow'){await send(user.id,overview(state,datePlus(today,cmd==='/tomorrow'?1:0)));return}
    if(cmd==='/week'){const rows=state.records.filter(r=>r.date>=today&&r.date<=datePlus(today,6)&&active(r)).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));await send(user.id,'План на 7 дней\n\n'+(rows.length?rows.slice(0,35).map(r=>`${r.date.slice(5).split('-').reverse().join('.')} ${r.time} — ${r.name}`).join('\n'):'Записей нет.')+'\n\n'+footer(state));return}
    if(cmd==='/free'){const out=freeWindows(state,today,localNow(state.settings.timeZone).time);await send(user.id,(out===null?'Сегодня выходной по графику.':out.length?'Свободно сегодня:\n'+out.join('\n'):'Сегодня свободных окон больше нет.')+'\n\n'+footer(state));return}
    await send(user.id,cmd==='/help'?'Смена помогает вести личный план, хранить заметки и получать напоминания.\n\n/start — кабинет\n/today — сегодня\n/tomorrow — завтра\n/week — 7 дней\n/free — свободные окна\n/invite — приглашение второму пользователю\n\nНастройки, услуги и резервная копия находятся в приложении. Записи YCLIENTS подтягиваются, если владелец подключил календарь в настройках.':'Ваша смена — под рукой. Откройте кабинет, чтобы посмотреть план или добавить запись.');
  }
  function pause(){return new Promise(resolve=>{const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,5000);abort.signal.addEventListener('abort',done,{once:true})})}
  async function poll(){let offset=Number(store.meta('offset')||0);while(!stopped){try{const updates=await telegram(config,'getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});for(const update of updates){try{await handle(update)}catch{console.error('Bot update failed; no credentials logged.')}offset=update.update_id+1;store.meta('offset',offset)}}catch{if(!stopped)await pause()}}}
  async function notify(){
    if(busy||stopped)return;
    busy=true;
    try{await sendNotifications({config,store,send,now:localNow(store.read().settings.timeZone)})}
    finally{busy=false}
  }
  poll();notify().catch(()=>{});
  (async()=>{while(!stopped){try{await configureBot(config);console.log('Telegram menu configured.');break}catch{console.error('Telegram menu setup will retry.');await pause()}}})();
  const timer=setInterval(()=>notify().catch(()=>{}),30000);timer.unref();
  return {stop(){stopped=true;abort.abort();clearInterval(timer)},notify:text=>send(store.friend()||Number(config.ownerId),text)};
}
