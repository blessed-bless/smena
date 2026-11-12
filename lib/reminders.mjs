import {clock} from './core.mjs';
import {dayView,reminderView,footer,clientReminderView} from './views.mjs';
export {footer};
const moment=(date,time)=>Date.parse(date+'T'+time+':00Z')/60000;

export const summaryForDay=(state,date,today=null,url='')=>dayView(state,date,today,url).text;

// Что пора отправить прямо сейчас. key защищает от повторов; keyboard — кнопки действий под сообщением.
export function collectNotifications(state,now,url=''){
  const s=state.settings,items=[];
  if(s.morning&&now.time>=s.morningTime&&clock(now.time)-clock(s.morningTime)<15){
    const view=dayView(state,now.date,now.date,url);
    items.push({key:'morning:'+now.date,text:view.text,keyboard:view.keyboard});
  }
  if(s.reminders&&s.reminderMinutes>0)for(const r of state.records){
    const left=moment(r.date,r.time)-moment(now.date,now.time);
    if(r.type!=='block'&&['confirmed','waiting'].includes(r.status)&&left>0&&left<=s.reminderMinutes){
      const view=reminderView(state,r,left,url);
      items.push({key:`visit:${r.id}:${r.date}:${r.time}`,text:view.text,keyboard:view.keyboard});
    }
  }
  return items;
}

// Клиентам, записавшимся через Telegram: одно напоминание за сутки (или меньше, если до визита уже меньше суток).
export function clientDue(state,now){
  return state.records.filter(r=>r.clientTg&&r.origin==='online'&&r.status==='confirmed'&&(m=>m>0&&m<=1440)(moment(r.date,r.time)-moment(now.date,now.time)));
}
export async function clientReminders({store,send,now,title}){
  const note=store.read().settings.booking?.note||'';
  for(const r of clientDue(store.read(),now)){
    const key='client:'+r.id+':'+r.date+':'+r.time;
    if(!store.claim(key))continue;
    const view=clientReminderView(r,title,note,store.cabinet,now.date);
    try{await send(r.clientTg,view.text,view.keyboard)}
    catch(e){if(!e?.code)store.unclaim(key)} // клиент закрыл чат — не повторяем; сетевую ошибку повторит следующий круг
  }
}

export async function sendNotifications({config,store,send,now}){
  const url=config.publicUrl||'',keys=collectNotifications(store.read(),now,url).map(item=>item.key);
  for(const key of keys){
    // Перечитываем состояние перед каждой отправкой: визит могли отменить, а доступ — отозвать.
    const current=collectNotifications(store.read(),now,url).find(item=>item.key===key);
    if(!current||!store.claim(key))continue;
    try{await send(store.recipient(),current.text,current.keyboard)}
    catch{store.unclaim(key)}
  }
}
