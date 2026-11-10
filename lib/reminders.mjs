import {clock} from './core.mjs';
import {dayView,reminderView,footer} from './views.mjs';
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

export async function sendNotifications({config,store,send,now}){
  const url=config.publicUrl||'',keys=collectNotifications(store.read(),now,url).map(item=>item.key);
  for(const key of keys){
    // Перечитываем состояние перед каждой отправкой: визит могли отменить, а доступ — отозвать.
    const current=collectNotifications(store.read(),now,url).find(item=>item.key===key);
    if(!current||!store.claim(key))continue;
    try{await send(store.friend()||Number(config.ownerId),current.text,current.keyboard)}
    catch{store.unclaim(key)}
  }
}
