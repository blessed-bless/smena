import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {isDate,workday} from '../shared.mjs';

export class AppError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status}}
const invalid=message=>{throw new AppError('INVALID',message)};
export const clock=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export const active=r=>!['cancelled','noshow'].includes(r.status);
export function localNow(zone='Europe/Moscow',at=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
export function verifyTelegram(raw,token,now=Math.floor(Date.now()/1000)){
  if(typeof raw!=='string'||!raw||raw.length>16384||!token)throw new AppError('AUTH','Откройте приложение из Telegram.',401);
  const params=new URLSearchParams(raw),keys=[...params.keys()];
  if(new Set(keys).size!==keys.length)throw new AppError('AUTH','Некорректная подпись Telegram.',401);
  const hash=params.get('hash');params.delete('hash');
  if(!/^[a-f0-9]{64}$/i.test(hash||''))throw new AppError('AUTH','Некорректная подпись Telegram.',401);
  const sorted=[...params].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key}=${value}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const expected=createHmac('sha256',secret).update(sorted).digest();
  if(!timingSafeEqual(Buffer.from(hash,'hex'),expected))throw new AppError('AUTH','Не удалось подтвердить вход через Telegram.',401);
  const authDate=Number(params.get('auth_date'));
  if(!Number.isSafeInteger(authDate)||authDate>now+30||now-authDate>3600)throw new AppError('AUTH_EXPIRED','Вход устарел. Закройте и заново откройте приложение.',401);
  let user;try{user=JSON.parse(params.get('user'))}catch{}
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0)throw new AppError('AUTH','Не удалось определить пользователя.',401);
  return user;
}
export function initialState(){return {revision:0,records:[],clientNotes:{},dayOverrides:{},settings:{timeZone:'Europe/Moscow',start:'10:00',end:'19:00',workdays:[0,1,2,3,4,5,6],reminders:true,reminderMinutes:30,morning:false,morningTime:'09:00',services:[{name:'Мужская стрижка',duration:60,price:0},{name:'Стрижка и борода',duration:90,price:0},{name:'Оформление бороды',duration:30,price:0}]}}}
function validTime(v){return typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v)}
export function validateSettings(value){
  if(!value||typeof value!=='object')invalid('Проверьте настройки.');
  const {timeZone,start,end,workdays,reminderMinutes,morningTime,services}=value;
  try{new Intl.DateTimeFormat('ru',{timeZone}).format()}catch{invalid('Неизвестный часовой пояс.')}
  if(typeof timeZone!=='string'||!validTime(start)||!validTime(end)||clock(end)-clock(start)<30)invalid('Проверьте начало и конец рабочего дня.');
  if(!Array.isArray(workdays)||workdays.length>7||workdays.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(workdays).size!==workdays.length)invalid('Проверьте рабочие дни.');
  if(![0,15,30,60,120].includes(reminderMinutes)||!validTime(morningTime))invalid('Проверьте время напоминаний.');
  if(!Array.isArray(services)||!services.length||services.length>20)invalid('Добавьте от 1 до 20 услуг.');
  const clean=services.map(s=>{if(!s||typeof s!=='object')invalid('Проверьте название, длительность и цену услуги.');const name=String(s.name||'').trim();if(!name||name.length>80||!Number.isInteger(s.duration)||s.duration<15||s.duration>480||s.duration%15||!Number.isFinite(s.price)||s.price<0||s.price>1000000)invalid('Проверьте название, длительность и цену услуги.');return {name,duration:s.duration,price:s.price}});
  if(new Set(clean.map(s=>s.name)).size!==clean.length)invalid('Названия услуг должны отличаться.');
  return {timeZone,start,end,workdays:[...workdays],reminders:value.reminders===true,reminderMinutes,morning:value.morning===true,morningTime,services:clean};
}
export function validateRecord(value,state,{checkSchedule=true,checkOverlap=true,allowLegacyService=false}={}){
  if(!value||typeof value!=='object')invalid('Проверьте данные записи.');
  const date=value.date,time=value.time,type=value.type==='block'?'block':'visit',status=String(value.status||'confirmed');
  const name=type==='block'?'Время закрыто':String(value.name||'').trim();
  const service=type==='block'?'Перерыв':String(value.service||'').trim();
  const phone=String(value.phone||'').trim(),note=String(value.note||'').trim(),synced=allowLegacyService&&value.source==='yclients',step=synced?1:5;
  if(typeof date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)invalid('Укажите существующую дату.');
  if(!validTime(time)||clock(time)%step)invalid('Время записи указывается с шагом 5 минут, например 14:55.');
  if(!name||name.length>80||!service||service.length>80||note.length>1000||phone.length>40)invalid('Проверьте имя, телефон и длину заметки.');
  if(!['confirmed','waiting','arrived','done','cancelled','noshow'].includes(status))invalid('Неизвестный статус визита.');
  const duration=Number(value.duration),price=Number(value.price||0),start=clock(time),end=start+duration;
  if(!Number.isInteger(duration)||duration<(synced?1:15)||duration>(synced?1440:480)||duration%step||end>1440||!Number.isFinite(price)||price<0||price>1000000)invalid('Проверьте длительность и цену.');
  if(!allowLegacyService&&type==='visit'&&!state.settings.services.some(s=>s.name===service)&&!state.records.some(r=>r.id===value.id&&r.service===service))invalid('Выберите услугу из списка.');
  const hours=workday(state,date);
  const same=state.records.some(r=>r.id===value.id&&r.date===date&&r.time===time&&r.duration===duration);
  if(checkSchedule&&active({status})&&!same&&(hours.closed||start<clock(hours.start)||end>clock(hours.end)))invalid('Визит должен помещаться в рабочее время выбранного дня.');
  if(checkOverlap&&active({status})&&state.records.some(r=>r.id!==value.id&&r.date===date&&active(r)&&start<clock(r.time)+r.duration&&end>clock(r.time)))invalid('Это время занято. Выберите свободное окно.');
  const old=state.records.find(r=>r.id===value.id),src=old?.source||(allowLegacyService&&value.source==='yclients'?'yclients':null),ext=old?.externalId||(src&&typeof value.externalId==='string'&&value.externalId.length<=100?value.externalId:null);
  return {id:value.id||randomUUID(),name,service,date,time,duration,status,note,phone,price,type,...(src?{source:src,externalId:ext}:{}),updatedAt:new Date().toISOString()};
}
// Создание или изменение записи в переданном состоянии — одно правило для приложения и для бота.
export function upsertRecord(state,input){
  const old=input?.id&&state.records.find(r=>r.id===input.id);
  if(input?.id&&!old)throw new AppError('NOT_FOUND','Запись не найдена.',404);
  if(old?.source==='yclients')throw new AppError('READONLY','Запись из YCLIENTS меняется только в YCLIENTS.',403);
  if(state.records.length>=5000&&!input?.id)throw new AppError('LIMIT','Достигнут лимит записей. Сохраните резервную копию.');
  const record=validateRecord(input,state);
  state.records=state.records.filter(r=>r.id!==record.id).concat(record);
  return record;
}

export function validateDayOverride(date,value,state){
  if(!isDate(date))invalid('Укажите существующую дату.');
  let result=null;
  if(value!==null){
    if(!value||typeof value.closed!=='boolean')invalid('Проверьте график выбранного дня.');
    const start=value.start||state.settings.start,end=value.end||state.settings.end;
    if(!validTime(start)||!validTime(end)||clock(end)-clock(start)<15)invalid('Проверьте начало и конец смены.');
    result={closed:value.closed,start,end};
  }
  const overrides={...state.dayOverrides};
  if(result)overrides[date]=result;else delete overrides[date];
  const hours=workday({...state,dayOverrides:overrides},date);
  if(state.records.some(r=>r.date===date&&active(r)&&(hours.closed||clock(r.time)<clock(hours.start)||clock(r.time)+r.duration>clock(hours.end))))
    invalid('Новый график исключает существующую запись. Сначала перенесите или отмените её.');
  return result;
}

export function validateBackup(value){
  if(!value||!['smena-v1','smena-v2'].includes(value.format)||!Array.isArray(value.records)||value.records.length>5000)
    invalid('Выберите резервную копию «Смены» с количеством записей до 5000.');
  const settings=validateSettings(value.settings),dayOverrides={},notes=value.clientNotes??{},ids=new Set();
  if(!notes||typeof notes!=='object'||Array.isArray(notes)||Object.keys(notes).length>5000)invalid('Некорректные заметки в копии.');
  const clientNotes={};
  for(const [name,note]of Object.entries(notes)){
    if(!name.trim()||name.length>80||typeof note!=='string'||note.length>1000)invalid('Некорректная заметка клиента в копии.');
    Object.defineProperty(clientNotes,name,{value:note,enumerable:true,writable:true,configurable:true});
  }
  const overrides=value.dayOverrides??{};
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).length>1000)invalid('Некорректный график в копии.');
  const clean={revision:0,records:[],settings,dayOverrides,clientNotes};
  for(const [date,override]of Object.entries(overrides)){
    if(override===null)invalid('Некорректный график в копии.');
    dayOverrides[date]=validateDayOverride(date,override,clean);
  }
  for(const input of value.records){
    if(!input||typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)||ids.has(input.id))invalid('В копии повторяются или повреждены идентификаторы записей.');
    ids.add(input.id);
    clean.records.push(validateRecord(input,clean,{checkSchedule:false,checkOverlap:false,allowLegacyService:true}));
  }
  const live=clean.records.filter(r=>active(r)&&r.source!=='yclients').sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  for(let i=1;i<live.length;i++)if(live[i].date===live[i-1].date&&clock(live[i].time)<clock(live[i-1].time)+live[i-1].duration)
    invalid('В резервной копии есть пересекающиеся записи.');
  return clean;
}
