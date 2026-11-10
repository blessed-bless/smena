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
