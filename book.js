// Страница онлайн-записи для клиентов барбера. Открывается из бота (Telegram подписывает клиента) или по прямой ссылке.
const tg=window.Telegram?.WebApp,inTg=!!tg?.initData,$=s=>document.querySelector(s),root=$('#book');
const params=new URLSearchParams(location.search),slug=params.get('c')||'',offer={date:params.get('d'),time:params.get('t')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(d,o)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',...o}).format(new Date(d+'T12:00:00Z'));
const money=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n).replace(/[  ]/g,' ')+' ₽';
const dur=n=>n>=60?Math.floor(n/60)+' ч'+(n%60?' '+n%60+' мин':''):n+' мин';
const plural=(n,a,b,c)=>n%100>=11&&n%100<=14?c:n%10===1?a:n%10>=2&&n%10<=4?b:c;
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const longDay=d=>cap(fmt(d,{weekday:'long',day:'numeric',month:'long'}));
const CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const saved=()=>{try{return JSON.parse(localStorage.getItem('smena-book:'+slug)||'null')}catch{return null}};
const remember=v=>{try{v?localStorage.setItem('smena-book:'+slug,JSON.stringify(v)):localStorage.removeItem('smena-book:'+slug)}catch{}};

let info=null,service=null,slots=[],day=null,time=null,mode='book',busy=false,toastTimer;
function theme(){const dark=inTg?tg.colorScheme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=dark?'dark':'light'}
function toast(text){const t=$('#toast');t.textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.textContent='',4200)}
const haptic=k=>{try{k==='select'?tg?.HapticFeedback?.selectionChanged():tg?.HapticFeedback?.notificationOccurred(k)}catch{}};
async function api(path,body){
  const res=await fetch('/api/'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({c:slug,...body,...(inTg?{initData:tg.initData}:{})})}:{});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(Error(data.message||'Не удалось связаться с сервером. Проверьте интернет.'),{status:res.status,code:data.error});
  return data;
}

function hero(){
  return `<header class="book-hero"><p>Онлайн-запись</p><h1>${esc(cap(info.title))}</h1>${info.note?`<p class="book-note">${esc(info.note)}</p>`:''}</header>`;
}
// Запись этого устройства (вне Telegram): показываем её и даём отменить, если планы поменялись.
function mineCard(){
  const m=saved(),today=new Date().toISOString().slice(0,10);
  if(inTg||!m||m.date<today)return '';
  return `<section class="mine"><p><b>Вы записаны:</b> ${esc(longDay(m.date))}, ${esc(m.time)} — ${esc(m.service)}</p><div class="actions"><button class="secondary" data-action="cancel">Отменить запись</button></div></section>`;
}
function servicesStep(){
  return `<section class="step"><h2>Услуга</h2><div class="services">${info.services.map((s,i)=>`<button type="button" class="service" data-action="service" data-i="${i}" aria-pressed="${service===i}"><span><b>${esc(s.name)}</b><small>${dur(s.duration)}</small></span>${s.price?`<span class="price num">${money(s.price)}</span>`:''}</button>`).join('')}</div></section>`;
}
function daysStep(){
  if(service===null)return '';
  if(!slots.length)return `<section class="step"><h2>Время</h2><p class="empty-step">На ближайшие ${info.days} ${plural(info.days,'день','дня','дней')} свободного времени нет. Оставьте контакт — мастер напишет, когда освободится окно.</p><button class="primary wait-link" data-action="wait">Встать в лист ожидания</button></section>`;
  const times=slots.find(([d])=>d===day)?.[1]||[];
  return `<section class="step"><h2>День <small>${esc(cap(fmt(day,{month:'long'})))}</small></h2><div class="days" role="group" aria-label="День">${slots.map(([d,t])=>`<button type="button" class="day" data-action="day" data-d="${d}" aria-pressed="${d===day}" aria-label="${esc(longDay(d))}, окон: ${t.length}"><small>${esc(fmt(d,{weekday:'short'}))}</small><b class="num">${Number(d.slice(8))}</b><i>${t.length} ${plural(t.length,'окно','окна','окон')}</i></button>`).join('')}</div></section>
<section class="step"><h2>Время <small>${esc(longDay(day))}</small></h2><div class="times" role="group" aria-label="Время">${times.map(t=>`<button type="button" class="time num${offer.date===day&&offer.time===t?' offered':''}" data-action="time" data-t="${t}" aria-pressed="${t===time}">${t}</button>`).join('')}</div>
<button class="text-button wait-link" data-action="wait">Нет удобного времени? Встать в лист ожидания</button></section>`;
}
function contactStep(){
  if(time===null)return '';
  const user=inTg?tg.initDataUnsafe?.user:null,name=[user?.first_name,user?.last_name].filter(Boolean).join(' ');
  return `<section class="step"><h2>Ваши данные</h2><form id="book-form" class="contact" novalidate>
<label class="field">Имя<input name="name" autocomplete="name" maxlength="80" required value="${esc(name)}" placeholder="Как к вам обращаться"></label>
<label class="field">Телефон${inTg?' — если удобно':''}<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" ${inTg?'':'required'} placeholder="+7 900 000-00-00"></label>
<label class="trap" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label>
<p class="inline-hint">${inTg?'Подтверждение и напоминание за сутки придут в этот чат.':'Телефон увидит только мастер — чтобы связаться, если что-то изменится.'}</p></form></section>`;
}
function bar(){
  if(time===null)return '';
  const s=info.services[service];
  return `<div class="book-bar"><button class="primary" data-action="book" ${busy?'disabled':''}>Записаться <span>${esc(fmt(day,{weekday:'short',day:'numeric'}))}, ${time}</span></button></div>`;
}
function render(){
  if(mode==='wait')return renderWait();
  root.innerHTML=hero()+mineCard()+servicesStep()+daysStep()+contactStep()+bar();
}
function renderWait(){
  const user=inTg?tg.initDataUnsafe?.user:null,name=[user?.first_name,user?.last_name].filter(Boolean).join(' ');
  root.innerHTML=hero()+`<section class="step"><h2>Лист ожидания</h2><p class="inline-hint" style="margin:0 0 12px">Мастер напишет, когда освободится подходящее время.${inTg?' Сообщение придёт в этот чат.':''}</p>
<form id="wait-form" class="contact" novalidate>
<label class="field">Услуга<select name="service" class="secondary" style="justify-content:flex-start">${info.services.map((s,i)=>`<option value="${i}" ${i===(service??0)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
<label class="field">Имя<input name="name" autocomplete="name" maxlength="80" required value="${esc(name)}"></label>
<label class="field">Телефон${inTg?' — если удобно':''}<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" ${inTg?'':'required'} placeholder="+7 900 000-00-00"></label>
<label class="field">Когда удобно<textarea name="note" maxlength="300" placeholder="Например: будни после 18:00"></textarea></label>
<label class="trap" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label></form>
<button class="text-button wait-link" data-action="back">Вернуться к выбору времени</button></section>
<div class="book-bar"><button class="primary" data-action="wait-send" ${busy?'disabled':''}>Встать в лист ожидания</button></div>`;
}
function doneScreen(rec,key){
  $('#toast').textContent='';
  const ics=key?calendarLink(rec):'';
  root.innerHTML=`<section class="done"><div class="done-mark">${CHECK}</div><h1>Вы записаны</h1><p class="when num">${esc(longDay(rec.date))}<br>${rec.time}</p><p class="what">${esc(rec.service)}, ${dur(rec.duration)}${rec.price?', '+money(rec.price):''}<br>Мастер: ${esc(info.title)}</p>
${info.note?`<p class="what">${esc(info.note)}</p>`:''}
<p class="inline-hint">${inTg?'Подтверждение пришло в чат с ботом, там же можно отменить запись.':'Если планы поменяются — отмените запись здесь же, по этой ссылке, чтобы время досталось другому.'}</p>
<div class="actions">${ics}${inTg?'<button class="primary" data-action="close">Готово</button>':'<button class="secondary" data-action="cancel">Отменить запись</button>'}</div></section>`;
}
// Событие для календаря телефона. Время — местное время мастера.
function calendarLink(r){
  const t=(d,m)=>d.replaceAll('-','')+'T'+String(Math.floor(m/60)).padStart(2,'0')+String(m%60).padStart(2,'0')+'00';
  const start=Number(r.time.slice(0,2))*60+Number(r.time.slice(3));
  const body=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Smena//RU','BEGIN:VEVENT','UID:'+r.date+r.time+'@smena','DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z','DTSTART:'+t(r.date,start),'DTEND:'+t(r.date,start+r.duration),'SUMMARY:'+(r.service+' — '+info.title).replace(/[,;\n]/g,' '),...(info.note?['LOCATION:'+info.note.replace(/[,;\n]/g,' ')]:[]),'BEGIN:VALARM','TRIGGER:-PT2H','ACTION:DISPLAY','DESCRIPTION:Запись к барберу','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n');
  return `<a class="secondary" download="zapis.ics" href="data:text/calendar;charset=utf-8,${encodeURIComponent(body)}">Добавить в календарь</a>`;
}

async function pickService(i){
  service=i;day=null;time=null;haptic('select');
  try{slots=(await api('book/slots?c='+encodeURIComponent(slug)+'&s='+i)).slots}catch(e){toast(e.message);slots=[]}
  day=(offer.date&&slots.some(([d])=>d===offer.date)?offer.date:slots[0]?.[0])||null;
  if(day===offer.date&&slots.find(([d])=>d===day)[1].includes(offer.time))time=offer.time;
  render();
  document.querySelector('.days [aria-pressed="true"]')?.scrollIntoView({inline:'center',block:'nearest'});
}
async function submit(){
  const form=$('#book-form'),data=new FormData(form),name=data.get('name').trim(),phone=data.get('phone').trim();
  if(!name){toast('Напишите, как вас зовут.');form.name.focus();return}
  if(!inTg&&phone.replace(/\D/g,'').length<10){toast('Укажите телефон: по нему мастер свяжется с вами.');form.phone.focus();return}
  busy=true;render();
  try{
    const res=await api('book',{service,date:day,time,name,phone,website:data.get('website')});
    if(!inTg)remember({key:res.key,...res.record});
    haptic('success');busy=false;doneScreen(res.record,!inTg);window.scrollTo(0,0);
  }catch(e){
    busy=false;haptic('error');toast(e.message);
    if(e.status===409){const keep={name,phone};await pickService(service);const f=$('#book-form');if(f){f.name.value=keep.name;f.phone.value=keep.phone}}else render();
  }
}
async function sendWait(){
  const form=$('#wait-form'),data=new FormData(form),name=data.get('name').trim(),phone=data.get('phone').trim();
  if(!name){toast('Напишите, как вас зовут.');return}
  if(!inTg&&phone.replace(/\D/g,'').length<10){toast('Укажите телефон: по нему мастер позовёт вас.');return}
  busy=true;renderWait();
  try{
    await api('book/wait',{service:Number(data.get('service')),name,phone,note:data.get('note').trim(),website:data.get('website')});
    haptic('success');busy=false;
    root.innerHTML=`<section class="done"><div class="done-mark">${CHECK}</div><h1>Вы в листе ожидания</h1><p class="what">Мастер напишет${inTg?' сюда, в Telegram,':' или позвонит'}, когда освободится время.</p><div class="actions">${inTg?'<button class="primary" data-action="close">Готово</button>':'<button class="secondary" data-action="back">К выбору времени</button>'}</div></section>`;
  }catch(e){busy=false;toast(e.message);renderWait()}
}
async function cancel(){
  const m=saved();if(!m)return;
  if(!confirm(`Отменить запись на ${longDay(m.date)}, ${m.time}?`))return;
  try{await api('book/cancel',{key:m.key});remember(null);toast('Запись отменена. Спасибо, что предупредили.');mode='book';render()}
  catch(e){if(e.status===404){remember(null);render()}toast(e.message)}
}

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-action]');if(!b||busy&&b.dataset.action!=='close')return;
  const a=b.dataset.action;
  if(a==='service')pickService(Number(b.dataset.i));
  else if(a==='day'){day=b.dataset.d;time=null;haptic('select');render()}
  else if(a==='time'){time=b.dataset.t;haptic('select');const keep=$('#book-form')&&{name:$('#book-form').name.value,phone:$('#book-form').phone.value};render();if(keep){$('#book-form').name.value=keep.name;$('#book-form').phone.value=keep.phone}$('#book-form')?.scrollIntoView({behavior:'smooth',block:'center'})}
  else if(a==='book')submit();
  else if(a==='wait'){mode='wait';renderWait();window.scrollTo(0,0)}
  else if(a==='wait-send')sendWait();
  else if(a==='back'){mode='book';render()}
  else if(a==='cancel')cancel();
  else if(a==='close'){if(inTg)tg.close();else{mode='book';render()}}
});
document.addEventListener('submit',e=>{e.preventDefault();if(e.target.id==='book-form')submit();else if(e.target.id==='wait-form')sendWait()});

async function init(){
  if(inTg){tg.ready();tg.expand();tg.onEvent?.('themeChanged',theme)}else matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',theme);
  theme();
  if(!slug){root.innerHTML='<section class="book-error"><h1>Ссылка неполная</h1><p>Попросите у мастера ссылку на запись ещё раз.</p></section>';return}
  try{info=await api('book/info?c='+encodeURIComponent(slug))}
  catch(e){root.innerHTML=`<section class="book-error"><h1>Запись недоступна</h1><p>${esc(e.message)}</p></section>`;return}
  document.title='Запись: '+info.title;
  if(info.services.length===1||offer.date)await pickService(0);else render();
}
init();
