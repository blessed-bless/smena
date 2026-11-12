// Онлайн-запись клиентов: что видит клиент, как он записывается и отменяет запись, лист ожидания.
// Модуль общий для сервера (страница записи) и бота (кнопки «Отменить», «Предложить окно»): одно правило везде.
import {createHash,randomBytes} from 'node:crypto';
import {AppError,localNow,upsertRecord,validateWaiting} from './core.mjs';
import {bookingSlots,phoneDigits,isActive,isVisit} from '../shared.mjs';

export const keyHash=key=>createHash('sha256').update(String(key)).digest('hex');
const closed=()=>new AppError('BOOKING_OFF','Онлайн-запись к этому мастеру сейчас выключена.',404);
// Как мастер подписан для клиентов: своё имя из настроек, иначе имя сотрудника в YCLIENTS.
export const masterTitle=db=>db.read().settings.booking.title||db.account()?.staff||'мастер';

// Кабинет по публичной ссылке. Выключенная запись и неизвестная ссылка выглядят одинаково.
export function bookingCabinet(store,slug){
  const id=store.cabinetBySlug(slug);if(id===null)throw closed();
  const db=store.scope(id);if(!db.read().settings.booking.enabled)throw closed();
  return db;
}
export function bookingInfo(db){
  const s=db.read().settings;
  return {title:masterTitle(db),note:s.booking.note,days:s.booking.days,services:s.services.map(x=>({name:x.name,duration:x.duration,price:x.price}))};
}
export function serviceAt(state,index){
  const s=Number.isInteger(index)?state.settings.services[index]:null;
  if(!s)throw new AppError('INVALID','Выберите услугу из списка.');
  return s;
}
export function slotsFor(db,index,at=new Date()){
  const state=db.read(),s=serviceAt(state,index),now=localNow(state.settings.timeZone,at);
  return bookingSlots(state,s.duration,now.date,now.time);
}
// Будущие активные онлайн-записи этого клиента: по Telegram или по телефону.
const mine=(state,today,clientTg,digits)=>state.records.filter(r=>r.origin==='online'&&isActive(r)&&r.status!=='done'&&r.date>=today&&(clientTg&&r.clientTg===clientTg||digits&&phoneDigits(r.phone)===digits));

// Запись клиента. clientTg — проверенный id Telegram (если страница открыта из бота), иначе обязателен телефон.
export function book(db,input,{clientTg=null,at=new Date()}={}){
  const name=String(input.name||'').trim().slice(0,80),phone=String(input.phone||'').trim().slice(0,40),digits=phoneDigits(phone);
  if(!name)throw new AppError('INVALID','Напишите, как вас зовут.');
  if(!clientTg&&!digits)throw new AppError('INVALID','Укажите телефон: по нему мастер свяжется с вами.');
  const key=randomBytes(18).toString('base64url');let saved;
  db.mutate(db.read().revision,state=>{
    if(!state.settings.booking.enabled)throw closed();
    const s=serviceAt(state,input.service),now=localNow(state.settings.timeZone,at);
    if(mine(state,now.date,clientTg,digits).length>=2)throw new AppError('LIMIT','У вас уже есть две записи. Чтобы записаться ещё, отмените одну из них.',429);
    const day=bookingSlots(state,s.duration,now.date,now.time).find(([d])=>d===input.date);
    if(!day||!day[1].includes(input.time))throw new AppError('TAKEN','Это время уже заняли. Выберите другое.',409);
    // Постоянный клиент записывается под тем же именем, что и в журнале мастера, — история визитов не теряется.
    const known=digits&&state.records.findLast(r=>isVisit(r)&&phoneDigits(r.phone)===digits)?.name;
    saved=upsertRecord(state,{name:known||name,phone,service:s.name,duration:s.duration,price:s.price,date:input.date,time:input.time,status:'confirmed',type:'visit',note:known&&known!==name?'Онлайн-запись: '+name:'Онлайн-запись'});
    Object.assign(saved,{origin:'online',cancelKey:keyHash(key),...(clientTg?{clientTg}:{})});
    // Записался — значит, больше не ждёт окна.
    state.waitlist=state.waitlist.filter(w=>!(clientTg&&w.clientTg===clientTg||digits&&phoneDigits(w.phone)===digits));
    return state;
  },'Онлайн-запись');
  return {record:saved,key};
}
// Отмена онлайн-записи клиентом: по секретному ключу со страницы или по кнопке в боте (find).
export function cancelBooking(db,find,at=new Date()){
  let saved;
  db.mutate(db.read().revision,state=>{
    const r=state.records.find(find),now=localNow(state.settings.timeZone,at);
    if(!r||r.origin!=='online')throw new AppError('NOT_FOUND','Запись не найдена.',404);
    if(!isActive(r)||r.status==='done'||r.status==='arrived')throw new AppError('INVALID','Эту запись уже нельзя отменить.');
    if(r.date+r.time<=now.date+now.time)throw new AppError('INVALID','Время визита уже прошло.');
    r.status='cancelled';r.updatedAt=new Date(at).toISOString();saved=r;return state;
  },'Клиент отменил онлайн-запись');
  return saved;
}
export function joinWaitlist(db,input,{clientTg=null}={}){
  let saved;
  db.mutate(db.read().revision,state=>{
    if(!state.settings.booking.enabled)throw closed();
    const service=Number.isInteger(input.service)?serviceAt(state,input.service).name:'';
    const digits=phoneDigits(input.phone);
    if(!clientTg&&!digits)throw new AppError('INVALID','Укажите телефон: по нему мастер позовёт вас, когда освободится время.');
    if(state.waitlist.some(w=>clientTg&&w.clientTg===clientTg||digits&&phoneDigits(w.phone)===digits))throw new AppError('EXISTS','Вы уже в листе ожидания. Мастер напишет, когда освободится время.',409);
    saved=validateWaiting({name:input.name,phone:input.phone,service,note:input.note,clientTg,origin:'online'},state);
    state.waitlist.push(saved);return state;
  },'Лист ожидания');
  return saved;
}
// Кому предложить освободившееся окно: те, кто ждёт эту услугу, затем все остальные. Самые давние — первыми.
export function waitingFor(state,record,limit=3){
  return [...state.waitlist].sort((a,b)=>(b.service===record.service)-(a.service===record.service)||a.createdAt.localeCompare(b.createdAt)).slice(0,limit);
}
