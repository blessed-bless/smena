// Синхронизация записей из YCLIENTS (только чтение).
// Два источника:
//  1) iCal: YCLIENTS официально выгружает записи сотрудника в Google Календарь,
//     а у Google Календаря есть «секретный адрес в формате iCal». Пароль не нужен.
//  2) Официальный REST API YCLIENTS: partner token + user token (переменные окружения).
import {createHash} from 'node:crypto';
import {BlockList,isIP} from 'node:net';
import {lookup as dnsLookup} from 'node:dns/promises';
import {localNow,clock,active} from './core.mjs';

const MAX_FEED=5*1024*1024,MAX_RECORDS=3000;
const sha=s=>createHash('sha256').update(s).digest('hex').slice(0,32);
const pad=n=>String(n).padStart(2,'0');
export const shiftDate=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
function validZone(zone){if(!zone)return null;try{new Intl.DateTimeFormat('en',{timeZone:zone});return zone}catch{return null}}

// Настенное время в зоне -> момент времени (учитывает переход на летнее время).
export function wallToInstant(date,time,zone){
  const [y,m,d]=date.split('-').map(Number),[hh,mm,ss=0]=time.split(':').map(Number);
  const target=Date.UTC(y,m-1,d,hh,mm,ss);let t=target;
  for(let i=0;i<3;i++){
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t)).map(x=>[x.type,x.value]));
    const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    if(shown===target)break;t+=target-shown;
  }
  return new Date(t);
}

// ---------- iCal ----------
export function parseICS(text){
  const lines=String(text).replace(/\r?\n[ \t]/g,'').split(/\r?\n/),events=[];let ev=null,depth=0;
  for(const line of lines){
    if(line==='BEGIN:VEVENT'){ev={};depth=0;continue}
    if(line==='END:VEVENT'){if(ev)events.push(ev);ev=null;continue}
    if(!ev)continue;
    if(line.startsWith('BEGIN:')){depth++;continue}       // VALARM и т.п.
    if(line.startsWith('END:')){depth--;continue}
    if(depth>0)continue;
    const i=line.indexOf(':');if(i<1)continue;
    const [name,...params]=line.slice(0,i).split(';');
    ev[name.toUpperCase()]={value:line.slice(i+1),params:Object.fromEntries(params.map(p=>{const j=p.indexOf('=');return [p.slice(0,j).toUpperCase(),p.slice(j+1).replace(/^"|"$/g,'')]}))};
  }
  return events;
}
const unescapeText=s=>String(s||'').replace(/\\n/gi,'\n').replace(/\\([,;\\])/g,'$1').trim();
function icsTime(prop,zone){
  if(!prop||prop.params.VALUE==='DATE')return null;
  const m=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(prop.value);if(!m)return null;
  const date=`${m[1]}-${m[2]}-${m[3]}`,time=`${m[4]}:${m[5]}:${m[6]}`;
  return m[7]?new Date(`${date}T${time}Z`):wallToInstant(date,time,validZone(prop.params.TZID)||zone);
}
function isoDuration(v){const m=/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v||'');return m?((+m[1]||0)*7*1440+(+m[2]||0)*1440+(+m[3]||0)*60+(+m[4]||0)+Math.round((+m[5]||0)/60)):null}

function makeRecord({key,start,minutes,name,service,note='',phone='',price=0,status='confirmed'},zone){
  const local=localNow(zone,start),begin=clock(local.time);
  const duration=Math.max(5,Math.min(Number.isFinite(minutes)&&minutes>0?Math.round(minutes):60,1440-begin));
  const id='yc-'+sha(key);
  return {id,name:String(name||'Клиент').trim().slice(0,80)||'Клиент',service:String(service||'Запись YCLIENTS').trim().slice(0,80)||'Запись YCLIENTS',date:local.date,time:local.time,duration,status,note:String(note||'').trim().slice(0,1000),phone:String(phone||'').trim().slice(0,40),price:Number.isFinite(price)&&price>=0&&price<=1000000?price:0,type:'visit',source:'yclients',externalId:sha('ext:'+key)};
}

export function icsToRecords(text,zone,{from,to}={}){
  const out=[];
  for(const e of parseICS(text)){
    if(!e.UID||!e.DTSTART)continue;
    const start=icsTime(e.DTSTART,zone);if(!start||Number.isNaN(start.getTime()))continue;
    const end=icsTime(e.DTEND,zone),minutes=end?(end-start)/60000:isoDuration(e.DURATION?.value);
    const summary=unescapeText(e.SUMMARY?.value),[first,...rest]=summary.split(/\s+[—–-]\s+/),description=unescapeText(e.DESCRIPTION?.value);
    // Формат выгрузки зависит от настроек филиала, поэтому телефон и услугу ищем и в описании.
    const serviceLine=/^\s*(?:услуг[аи]?|service)\s*[:：]\s*(.+)$/im.exec(description)?.[1];
    const phone=/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.exec(description)?.[0]?.replace(/[\s()-]/g,'');
    const record=makeRecord({key:'ics:'+e.UID.value+(e['RECURRENCE-ID']?.value||''),start,minutes,name:first||'Запись YCLIENTS',service:rest.join(' — ')||serviceLine||'Запись YCLIENTS',phone,note:description,status:(e.STATUS?.value||'').toUpperCase()==='CANCELLED'?'cancelled':'confirmed'},zone);
    if(from&&record.date<from||to&&record.date>to)continue;
    out.push(record);
  }
  return out;
}

// ---------- REST API ----------
// attendance (или visit_attendance): -1 не пришёл, 0 ожидание, 1 пришёл, 2 подтвердил.
// Сверено с altegio/altegio-pro-mcp (vocabulary.ts) и slowprog/yclients-api (getRecords):
// GET https://api.yclients.com/api/v1/records/{company_id}, заголовок "Authorization: Bearer <partner>, User <user>".
// Удалённые записи по умолчанию не возвращаются — исчезновение из выдачи = отмена.
// services[].cost — итог строки после скидки, поэтому суммируется без умножения на amount.
export function apiToRecords(list,zone,now=new Date()){
  const out=[];
  for(const r of Array.isArray(list)?list:[]){
    if(!r||r.deleted||r.id==null)continue;
    const start=r.datetime?new Date(r.datetime):typeof r.date==='string'?wallToInstant(r.date.slice(0,10),r.date.slice(11,19)||'00:00:00',zone):null;
    if(!start||Number.isNaN(start.getTime()))continue;
    const seconds=Number(r.seance_length||r.length||0),services=Array.isArray(r.services)?r.services:[];
    const ended=start.getTime()+seconds*1000<=now.getTime();
    const status={'-1':'noshow','0':'waiting','1':ended?'done':'arrived','2':'confirmed'}[String(r.attendance??r.visit_attendance)]||'confirmed';
    out.push(makeRecord({key:'api:'+r.id,start,minutes:seconds?seconds/60:60,name:r.client?.name||r.client?.display_name||'Клиент',service:services.map(s=>s?.title).filter(Boolean).join(', '),phone:r.client?.phone,price:services.reduce((n,s)=>n+(Number(s?.cost)||0),0),note:r.comment,status},zone));
  }
  return out;
}

async function readLimited(response){
  const length=Number(response.headers.get('content-length')||0);if(length>MAX_FEED)throw Error('Календарь слишком большой.');
  const text=await response.text();if(text.length>MAX_FEED)throw Error('Календарь слишком большой.');return text;
}
// Ссылку на календарь задаёт владелец, но сервер не должен ходить по ней во внутреннюю сеть (SSRF):
// каждый адрес хоста и каждый шаг перенаправления проверяются до запроса.
const internal=new BlockList();
for(const [a,p] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',3]])internal.addSubnet(a,p,'ipv4');
for(const [a,p] of [['::',127],['64:ff9b::',96],['fc00::',7],['fe80::',10],['ff00::',8]])internal.addSubnet(a,p,'ipv6');
export function internalAddress(address){const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);if(mapped)return internalAddress(mapped[1]);if(/^::ffff:/i.test(address))return true;const v=isIP(address);return v===4?internal.check(address,'ipv4'):v===6?internal.check(address,'ipv6'):true}
export async function assertPublicHost(url,lookup=dnsLookup){
  const host=new URL(url).hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'');
  const list=isIP(host)?[{address:host}]:await lookup(host,{all:true,verbatim:true}).catch(()=>[]);
  if(!list.length)throw Error('Не удалось найти сервер календаря. Проверьте ссылку.');
  if(list.some(a=>internalAddress(a.address)))throw Error('Ссылка ведёт во внутреннюю сеть. Нужен адрес календаря в интернете.');
}
export function validateFeedUrl(value){
  if(typeof value!=='string'||value.length>2000)return null;
  let url;try{url=new URL(value.trim().replace(/^webcal:/i,'https:'))}catch{return null}
  return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
}

export function createSync({config,store,notify=async()=>{},fetchImpl=fetch,lookup=dnsLookup}){
  async function fetchFeed(start){
    let url=start;
    for(let hop=0;hop<5;hop++){
      const clean=validateFeedUrl(url);if(!clean)throw Error('Календарь перенаправил на неподходящий адрес.');
      await assertPublicHost(clean,lookup);
      const response=await fetchImpl(clean,{headers:{Accept:'text/calendar'},redirect:'manual',signal:AbortSignal.timeout(20000)});
      const next=response.status>=300&&response.status<400&&response.headers.get('location');
      if(!next)return response;
      url=new URL(next,clean).href;
    }
    throw Error('Слишком много перенаправлений по ссылке на календарь.');
  }
  let running=null;const api=config.yclients||{};
  const mode=()=>api.partnerToken&&api.userToken&&api.companyId&&api.staffId?'api':store.meta('sync_ics')?'ics':null;
  function status(){
    const m=mode(),at=Number(store.meta('sync_at')||0);
    let host='';if(m==='ics'){try{host=new URL(store.meta('sync_ics')).host}catch{}}
    return {mode:m,at:at||null,error:store.meta('sync_error')||'',count:Number(store.meta('sync_count')||0),host};
  }
  async function fetchRecords(zone){
    const today=localNow(zone).date;
    if(mode()==='api'){
      const from=shiftDate(today,-30),to=shiftDate(today,90),all=[];
      for(let page=1;page<=20;page++){
        const q=new URLSearchParams({staff_id:String(api.staffId),start_date:from,end_date:to,page:String(page),count:'200'});
        const response=await fetchImpl(`https://api.yclients.com/api/v1/records/${encodeURIComponent(api.companyId)}?${q}`,{headers:{Accept:'application/vnd.yclients.v2+json','Content-Type':'application/json',Authorization:`Bearer ${api.partnerToken}, User ${api.userToken}`},signal:AbortSignal.timeout(20000)});
        const data=await response.json().catch(()=>null);
        if(!response.ok||!data?.success){
          const detail=String(data?.meta?.message||data?.message||'').slice(0,150);
          throw Error(response.status===401||response.status===403?'YCLIENTS отклонил токены. Проверьте доступ к API.'+(detail?' '+detail:''):response.status===429?'YCLIENTS ограничил частоту запросов, повторим позже.':'YCLIENTS API: '+(detail||'ошибка '+response.status)+'.');
        }
        all.push(...(data.data||[]));if((data.data||[]).length<200)break;
      }
      return {records:apiToRecords(all,zone),from,to};
    }
    const from=shiftDate(today,-60),to=shiftDate(today,180);
    const response=await fetchFeed(store.meta('sync_ics'));
    if(!response.ok)throw Error(response.status===404?'Ссылка на календарь больше не работает. Скопируйте секретный адрес iCal заново.':'Календарь недоступен ('+response.status+').');
    const text=await readLimited(response);
    if(!text.includes('BEGIN:VCALENDAR'))throw Error('По ссылке не календарь. Нужен «Секретный адрес в формате iCal».');
    return {records:icsToRecords(text,zone,{from,to}),from,to};
  }
  async function runOnce(){
    if(!mode())return status();
    try{
      const zone=store.read().settings.timeZone,{records,from,to}=await fetchRecords(zone);
      if(!mode())return status(); // отключили во время загрузки
      const seeded=store.meta('sync_seeded')==='1',result=store.applySync(records.slice(0,MAX_RECORDS),{from,to});
      store.meta('sync_at',Date.now());store.meta('sync_error','');store.meta('sync_count',result.count);store.meta('sync_seeded','1');
      if(seeded){
        const today=localNow(zone).date;
        for(const r of result.added.filter(r=>active(r)&&r.date>=today).slice(0,10))await notify(`Новая запись в YCLIENTS\n${r.date.slice(5).split('-').reverse().join('.')} ${r.time} — ${r.name}\n${r.service}`).catch(()=>{});
        for(const r of result.removed.filter(r=>r.date>=today).slice(0,10))await notify(`Запись в YCLIENTS отменена\n${r.date.slice(5).split('-').reverse().join('.')} ${r.time} — ${r.name}\n${r.service}`).catch(()=>{});
      }
    }catch(e){store.meta('sync_error',String(e?.name==='TimeoutError'?'YCLIENTS не ответил вовремя.':e?.message||'Ошибка синхронизации.').slice(0,300))}
    return status();
  }
  function run(){if(!running)running=runOnce().finally(()=>{running=null});return running}
  function configure(url){
    if(url===null){store.meta('sync_ics','');store.meta('sync_error','');store.meta('sync_seeded','');store.meta('sync_at','');store.meta('sync_count','0');if(mode()!=='api')store.applySync([],null);return status()}
    const clean=validateFeedUrl(url);if(!clean)return null;
    store.meta('sync_ics',clean);store.meta('sync_seeded','');store.meta('sync_error','');return status();
  }
  let timer=null;
  function start(intervalMs=5*60*1000){run();timer=setInterval(run,intervalMs);timer.unref?.();return {stop(){clearInterval(timer)}}}
  return {mode,status,run,configure,start};
}
