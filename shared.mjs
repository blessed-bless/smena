// Общая логика рабочего дня. Этот модуль одинаково работает в браузере (app.js) и на сервере
// (бот, проверки), поэтому цифры в приложении и в чате всегда считаются одним кодом.
export function isDate(value){
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value+'T12:00:00Z');
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}

export function workday(state,date){
  const settings=state.settings;
  const override=state.dayOverrides&&Object.hasOwn(state.dayOverrides,date)?state.dayOverrides[date]:null;
  return {
    start:override?.start||settings.start,
    end:override?.end||settings.end,
    closed:override?override.closed:!settings.workdays.includes(new Date(date+'T12:00:00Z').getUTCDay()),
    overridden:!!override
  };
}

export const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export const hhmm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
export const isActive=r=>!['cancelled','noshow'].includes(r.status);
export const isVisit=r=>r.type!=='block';
export function shiftDate(date,n){
  const d=new Date(date+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+n);
  return d.toISOString().slice(0,10);
}
export const daysBetween=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);
const byMoment=(a,b)=>(a.date+a.time).localeCompare(b.date+b.time);

// Свободные окна дня в минутах от полуночи: [[начало, конец], …]. null — выходной.
// from отсекает прошедшее время, minGap — самое короткое окно, которое стоит показывать.
export function freeGaps(state,date,from=0,minGap=15){
  const hours=workday(state,date);
  if(hours.closed)return null;
  const end=mins(hours.end),out=[];
  let cursor=Math.max(mins(hours.start),from);
  const busy=state.records.filter(r=>r.date===date&&isActive(r)).sort((a,b)=>a.time.localeCompare(b.time));
  for(const r of busy){
    const start=Math.min(mins(r.time),end);
    if(start-cursor>=minGap)out.push([cursor,start]);
    cursor=Math.max(cursor,mins(r.time)+r.duration);
  }
  if(end-cursor>=minGap)out.push([cursor,end]);
  return out;
}

// Время начала, на которое помещается визит длиной duration: край окна и далее по сетке step.
export function slotStarts(state,date,duration,from=0,step=30){
  const gaps=freeGaps(state,date,from,duration);
  if(!gaps)return null;
  const out=[];
  for(const [start,end] of gaps){
    if(start%step&&start+duration<=end)out.push(hhmm(start));
    for(let t=Math.ceil(start/step)*step;t+duration<=end;t+=step)out.push(hhmm(t));
  }
  return out;
}

// Окна для онлайн-записи: дни от сегодня на booking.days вперёд, не раньше чем через booking.notice минут от текущего момента.
// Возвращает [[дата, [время…]], …] только для дней, где есть хотя бы одно окно.
export function bookingSlots(state,duration,today,now,booking=state.settings.booking){
  const earliest=mins(now)+(booking?.notice||0),out=[];
  for(let i=0;i<(booking?.days||14);i++){
    const from=earliest-i*1440;if(from>=1440)continue;
    const d=shiftDate(today,i),slots=slotStarts(state,d,duration,Math.max(0,Math.ceil(from/15)*15));
    if(slots?.length)out.push([d,slots]);
  }
  return out;
}

// Телефон в международном виде без знаков: 8 999 123-45-67 -> 79991234567. '' — если номер не разобрать.
export function phoneDigits(phone){
  const d=String(phone||'').replace(/\D/g,'');
  if(d.length===11&&(d[0]==='8'||d[0]==='7'))return '7'+d.slice(1);
  if(d.length===10)return '7'+d;
  return d.length>=11&&d.length<=15?d:'';
}

// Сводка по каждому клиенту: сколько раз был, когда был и когда придёт, как часто ходит, сколько оставил.
// «Состоявшийся» визит — завершённый либо активный в прошедшую дату (статус могли не отметить).
export function clientSummaries(state,today){
  const groups=new Map();
  for(const r of state.records){
    if(!isVisit(r))continue;
    if(!groups.has(r.name))groups.set(r.name,[]);
    groups.get(r.name).push(r);
  }
  const out=[];
  for(const [name,rows] of groups){
    rows.sort(byMoment);
    const happened=rows.filter(r=>r.status==='done'||isActive(r)&&(r.date<today||r.date===today&&r.status==='arrived'));
    const upcoming=rows.filter(r=>isActive(r)&&r.status!=='done'&&!happened.includes(r)&&r.date>=today);
    const dates=[...new Set(happened.map(r=>r.date))];
    const last=happened.at(-1)||null,next=upcoming[0]||null;
    out.push({
      name,
      total:rows.length,
      visits:happened.length,
      noshow:rows.filter(r=>r.status==='noshow').length,
      cancelled:rows.filter(r=>r.status==='cancelled').length,
      spent:happened.reduce((n,r)=>n+(r.price||0),0),
      first:rows[0].date,
      last,next,
      daysSince:last?daysBetween(last.date,today):null,
      interval:dates.length>1?Math.round(daysBetween(dates[0],dates.at(-1))/(dates.length-1)):null,
      phone:rows.findLast(r=>r.phone)?.phone||'',
      service:(last||next||rows.at(-1)).service
    });
  }
  return out;
}
// Давно не был: приходил, новой записи нет, и прошло заметно больше его обычного интервала (минимум 6 недель).
export const isLost=c=>!c.next&&c.daysSince!==null&&c.daysSince>=Math.max(42,Math.round((c.interval||0)*1.5));
export const isNew=(c,today)=>c.visits<=1&&daysBetween(c.first,today)<=30;

// Кого позвать в свободное окно: был хотя бы раз, новой записи нет и подходит его обычный срок (по умолчанию 4 недели).
// Первыми идут те, кто дольше всех «перехаживает» свой интервал.
export function dueClients(state,today,limit=3){
  const late=c=>c.daysSince-(c.interval||28);
  return clientSummaries(state,today).filter(c=>!c.next&&c.visits>0&&c.daysSince!==null&&c.daysSince>=Math.max(14,(c.interval||28)-5))
    .sort((a,b)=>late(b)-late(a)||a.name.localeCompare(b.name,'ru')).slice(0,limit);
}

// Следующий визит «не вставая с кресла»: через обычный интервал клиента, 4 и 6 недель.
// Для каждого срока — то же время в тот же день недели, иначе ближайшее окно в пределах ±3 дней.
export function nextVisitOptions(state,record,today,limit=3){
  const summary=clientSummaries(state,today).find(c=>c.name===record.name),usual=summary?.interval?Math.round(summary.interval/7):0;
  const weeks=[...new Set([...(usual>=1&&usual<=10?[usual]:[]),4,6])].slice(0,limit),out=[];
  for(const w of weeks){
    const target=shiftDate(record.date,w*7);let best=null;
    for(const delta of [0,1,-1,2,-2,3,-3]){
      const d=shiftDate(target,delta);if(d<=today)continue;
      const slots=slotStarts(state,d,record.duration)||[];if(!slots.length)continue;
      const time=slots.reduce((a,b)=>Math.abs(mins(b)-mins(record.time))<Math.abs(mins(a)-mins(record.time))?b:a);
      best={weeks:w,date:d,time,usual:w===usual,exact:delta===0&&time===record.time};break;
    }
    if(best&&!out.some(o=>o.date===best.date&&o.time===best.time))out.push(best);
  }
  return out;
}

// Деньги мастера за календарный месяц: выручка завершённых визитов и ещё не оказанных записей, умноженная на долю мастера.
export function monthMoney(state,today){
  const share=state.settings.share??100,goal=state.settings.goal||0,from=today.slice(0,8)+'01',end=shiftDate(shiftDate(from,32).slice(0,8)+'01',-1);
  const rows=state.records.filter(r=>isVisit(r)&&r.date>=from&&r.date<=end),part=n=>Math.round(n*share/100);
  const done=rows.filter(r=>r.status==='done'),ahead=rows.filter(r=>isActive(r)&&r.status!=='done'&&r.date>=today);
  const earned=part(done.reduce((n,r)=>n+(r.price||0),0)),booked=part(ahead.reduce((n,r)=>n+(r.price||0),0));
  const paid=done.filter(r=>r.price>0).length,avg=paid?Math.round(earned/paid):0,left=Math.max(0,goal-earned-booked);
  // Расходы месяца (аренда, материалы) вычитаются из заработанного: «чистыми» — то, что остаётся мастеру.
  const spent=(state.expenses||[]).filter(x=>x.date>=from&&x.date<=end).reduce((n,x)=>n+x.amount,0);
  return {from,end,share,goal,earned,booked,forecast:earned+booked,spent,net:earned-spent,left,avg,visitsToGoal:avg&&left?Math.ceil(left/avg):0,
    daysLeft:daysBetween(today,end)+1,priced:rows.some(r=>r.price>0)||state.settings.services.some(s=>s.price>0)};
}

// Таблицы для Excel: точка с запятой, BOM для кириллицы, формулы в ячейках обезврежены апострофом.
export const STATUS_RU={confirmed:'Подтверждена',waiting:'Ожидает ответа',arrived:'Пришёл',done:'Завершён',cancelled:'Отменена',noshow:'Не пришёл'};
const cell=x=>{const s=String(x??'');return /^[=+\-@\t\r]/.test(s)?`"'${s.replaceAll('"','""')}"`:`"${s.replaceAll('"','""')}"`};
const table=rows=>'﻿'+rows.map(r=>r.map(cell).join(';')).join('\r\n');
export function recordsCsv(state){
  return table([['Дата','Время','Длительность, мин','Клиент','Услуга','Статус','Цена, ₽','Телефон','Источник','Заметка'],
    ...state.records.filter(isVisit).sort(byMoment).map(r=>[r.date,r.time,r.duration,r.name,r.service,STATUS_RU[r.status]||r.status,r.price||0,r.phone,r.source==='yclients'?'YCLIENTS':r.origin==='online'?'Онлайн-запись':'Личный план',r.note])]);
}
export function clientsCsv(state,today){
  return table([['Клиент','Телефон','Визитов','Первый визит','Последний визит','Следующая запись','Ходит раз в, дней','Оставил, ₽','Не пришёл, раз','Заметка'],
    ...clientSummaries(state,today).sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(c=>[c.name,c.phone,c.visits,c.first,c.last?.date||'',c.next?c.next.date+' '+c.next.time:'',c.interval||'',c.spent,c.noshow,state.clientNotes?.[c.name]||''])]);
}

// Итоги периода [from, to] включительно: визиты, выручка, загрузка, услуги и разбивка по дням.
export function periodStats(state,from,to){
  const rows=state.records.filter(r=>isVisit(r)&&r.date>=from&&r.date<=to);
  const live=rows.filter(isActive),done=rows.filter(r=>r.status==='done');
  const noshow=rows.filter(r=>r.status==='noshow').length,cancelled=rows.filter(r=>r.status==='cancelled').length;
  const revenue=done.reduce((n,r)=>n+(r.price||0),0),paid=done.filter(r=>r.price>0).length;
  const firstSeen=new Map();
  for(const r of state.records)if(isVisit(r)&&isActive(r)&&(!firstSeen.has(r.name)||r.date<firstSeen.get(r.name)))firstSeen.set(r.name,r.date);
  const names=new Set(live.map(r=>r.name));
  const services=new Map();
  for(const r of live){
    const s=services.get(r.service)||{name:r.service,count:0,revenue:0};
    s.count++;if(r.status==='done')s.revenue+=r.price||0;
    services.set(r.service,s);
  }
  const byDay=[];let capacity=0;
  for(let d=from;d<=to;d=shiftDate(d,1)){
    const hours=workday(state,d);
    if(!hours.closed)capacity+=mins(hours.end)-mins(hours.start);
    byDay.push({date:d,count:live.filter(r=>r.date===d).length,revenue:done.filter(r=>r.date===d).reduce((n,r)=>n+(r.price||0),0)});
  }
  const minutes=live.reduce((n,r)=>n+r.duration,0);
  return {
    planned:live.length,done:done.length,noshow,cancelled,
    revenue,expected:live.filter(r=>r.status!=='done').reduce((n,r)=>n+(r.price||0),0),
    avgCheck:paid?Math.round(revenue/paid):0,
    minutes,capacity,load:capacity?Math.min(100,Math.round(minutes/capacity*100)):0,
    noshowRate:done.length+noshow?Math.round(noshow/(done.length+noshow)*100):0,
    clients:names.size,newClients:[...names].filter(n=>firstSeen.get(n)>=from).length,
    services:[...services.values()].sort((a,b)=>b.count-a.count||b.revenue-a.revenue),
    byDay
  };
}
