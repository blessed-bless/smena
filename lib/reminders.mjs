import {active,clock} from './core.mjs';
const moment=(date,time)=>Date.parse(date+'T'+time+':00Z')/60000;

export const footer=state=>state.records.some(r=>r.source==='yclients')?'Личный план и записи YCLIENTS.':'Личный план. YCLIENTS не подключён.';
export function summaryForDay(state,date){
  const rows=state.records.filter(r=>r.date===date&&active(r)).sort((a,b)=>a.time.localeCompare(b.time));
  let text=`Ваш план на ${date.split('-').reverse().join('.')}\n\n`,shown=0;
  for(const r of rows){
    const line=`${r.time}  ${r.type==='block'?'Время закрыто':r.name}${r.source==='yclients'?' (YCLIENTS)':''}\n${r.service} · ${r.duration} мин\n\n`;
    if(text.length+line.length>3400)break;
    text+=line;shown++;
  }
  if(!rows.length)text+='Записей нет.\n\n';
  if(shown<rows.length)text+=`Ещё ${rows.length-shown} — откройте приложение.\n\n`;
  return text+footer(state);
}

export function collectNotifications(state,now){
  const s=state.settings,items=[];
  if(s.morning&&now.time>=s.morningTime&&clock(now.time)-clock(s.morningTime)<15)
    items.push({key:'morning:'+now.date,text:summaryForDay(state,now.date)});
  if(s.reminders&&s.reminderMinutes>0)for(const r of state.records){
    const left=moment(r.date,r.time)-moment(now.date,now.time);
    if(r.type!=='block'&&['confirmed','waiting'].includes(r.status)&&left>0&&left<=s.reminderMinutes)
      items.push({key:`visit:${r.id}:${r.date}:${r.time}`,text:`Через ${left} мин: ${r.name}\n${r.time} — ${r.service}\n\n${r.source==='yclients'?'Запись из YCLIENTS.':'Личный план, без синхронизации с YCLIENTS.'}`});
  }
  return items;
}

export async function sendNotifications({config,store,send,now}){
  const keys=collectNotifications(store.read(),now).map(item=>item.key);
  for(const key of keys){
    const current=collectNotifications(store.read(),now).find(item=>item.key===key);
    if(!current||!store.claim(key))continue;
    try{await send(store.friend()||Number(config.ownerId),current.text)}
    catch{store.unclaim(key)}
  }
}
