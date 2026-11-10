'use strict';
import {workday,isDate,slotStarts,phoneDigits,clientSummaries,isLost,isNew,periodStats} from './shared.mjs';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',left:'<path d="m14 6-6 6 6 6"/>',right:'<path d="m10 6 6 6-6 6"/>',today:'<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4M16 3v4M4 11h16m-10 4 2 2 3-3"/>',calendar:'<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4M16 3v4M4 11h16M8 15h2M14 15h2"/>',clients:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',stats:'<path d="M5 20V11M12 20V4M19 20v-6M3 20h19"/>',settings:'<path d="M4 7h2m6 0h8M4 17h9m6 0h1"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',phone:'<path d="M6 3h3l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v3a3 3 0 0 1-3 3A15 15 0 0 1 3 6a3 3 0 0 1 3-3Z"/>',share:'<path d="M12 15V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',message:'<path d="M20 12a8 8 0 0 1-11.5 7.2L4 20l1-4.2A8 8 0 1 1 20 12Z"/>'};
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[n]}</svg>`;
const labels={confirmed:'Подтверждена',waiting:'Ожидает ответа',arrived:'Пришёл',done:'Завершён',cancelled:'Отменена',noshow:'Не пришёл'};
const active=r=>!['cancelled','noshow'].includes(r.status),parse=s=>new Date(s+'T12:00:00Z');
const iso=d=>d.toISOString().slice(0,10),shift=(s,n)=>{const d=parse(s);d.setUTCDate(d.getUTCDate()+n);return iso(d)};
const fmt=(s,o)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',...o}).format(parse(s));
const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),time=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const duration=n=>n>=60?Math.floor(n/60)+' ч'+(n%60?' '+n%60+' мин':''):n+' мин';
const plural=(n,a,b,c)=>n%100>=11&&n%100<=14?c:n%10===1?a:n%10>=2&&n%10<=4?b:c;
const money=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n)+' ₽';
const tg=window.Telegram?.WebApp,demo=location.pathname==='/demo';
let state,owner=false,hasFriend=false,date,month,tab='today',view='day',query='',editing=null,dirty=false,busy=false,toastTimer,botUsername='',today,sessionToken='',pendingImport=null,pendingImportRevision=null,demoPersistent=true;
const dialog=$('#dialog'),main=$('#main'),DEMO_KEY='smena-demo-v3';
function localToday(zone='Asia/Omsk'){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function defaults(){return {revision:0,records:[],clientNotes:{},dayOverrides:{},settings:{timeZone:'Asia/Omsk',start:'10:00',end:'19:00',workdays:[0,1,2,3,4,5,6],reminders:true,reminderMinutes:30,morning:false,morningTime:'09:00',services:[{name:'Мужская стрижка',duration:60,price:0},{name:'Стрижка и борода',duration:90,price:0},{name:'Оформление бороды',duration:30,price:0}]}}}
// Демоданные: сегодняшний день, записи вперёд и три месяца истории, чтобы обзор, карточки клиентов
// и список «давно не были» выглядели как у работающего мастера. Все имена и телефоны вымышлены.
function demoSeed(){
  const s=defaults(),d=localToday(),price={'Мужская стрижка':1500,'Стрижка и борода':2200,'Оформление бороды':800};
  for(const x of s.settings.services)x.price=price[x.name];
  const names=s.settings.services.map(x=>x.name);let n=0;
  const add=(offset,time,name,service,status='confirmed',note='',phone='')=>{const sv=s.settings.services.find(x=>x.name===service);s.records.push({id:'demo-'+n++,date:shift(d,offset),time,duration:sv.duration,name,service,status,note,phone,price:sv.price,type:'visit'})};
  add(0,'10:00','Алексей Морозов',names[0],'confirmed','Оставить длину сверху. По бокам — плавный переход.','+7 900 000-00-01');
  add(0,'11:30','Дмитрий Волков',names[1],'waiting','','+7 900 000-00-02');
  add(0,'14:00','Михаил Соколов',names[0]);
  add(0,'16:30','Артём Белов',names[2],'confirmed','Сохранить форму бороды.');
  add(1,'12:00','Игорь Лебедев',names[0],'confirmed','','+7 900 000-00-05');add(1,'15:30','Роман Орлов',names[1]);
  add(2,'11:00','Глеб Савин',names[1]);add(2,'15:00','Никита Фёдоров',names[0]);add(4,'13:00','Марк Дёмин',names[0]);
  const week=[[-1,'10:00','Игорь Лебедев',0],[-1,'12:00','Роман Орлов',1],[-1,'15:00','Егор Зайцев',2],[-2,'11:00','Тимур Азаров',0],[-2,'14:00','Сергей Кузнецов',0,'noshow'],[-3,'10:00','Глеб Савин',1],[-3,'13:00','Марк Дёмин',0],[-3,'16:00','Лев Исаев',0],[-4,'15:00','Никита Фёдоров',0],[-5,'12:00','Сергей Кузнецов',0],[-5,'17:00','Олег Панов',2],[-6,'11:00','Ян Котов',1],[-6,'14:30','Илья Громов',0,'cancelled']];
  for(const [offset,time,name,service,status='done'] of week)add(offset,time,name,names[service],status);
  const regular=['Алексей Морозов','Дмитрий Волков','Михаил Соколов','Артём Белов','Игорь Лебедев','Роман Орлов','Глеб Савин','Марк Дёмин'];
  for(let w=8;w<=88;w++){
    if(w%7===3)continue;
    for(let j=0;j<1+w%3;j++)add(-w,['10:00','13:00','16:00'][j],regular[(w*7+j*3)%regular.length],names[(w+j)%3],'done');
  }
  add(-62,'18:00','Павел Никитин',names[0],'done','','+7 900 000-00-09');add(-95,'18:00','Павел Никитин',names[0],'done');
  s.clientNotes={'Алексей Морозов':'Любит покороче на висках. Кофе без сахара.','Павел Никитин':'Приходит после работы, удобнее вечер.'};
  return s;
}
function readPreference(key,fallback){try{return localStorage.getItem(key)||fallback}catch{return fallback}}
function storePreference(key,value){try{localStorage.setItem(key,value);return true}catch{return false}}
function theme(){const p=readPreference('smena-theme','auto'),dark=p==='dark'||p==='auto'&&(tg?.colorScheme==='dark'||!tg?.initData&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=dark?'dark':'light';const bg=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();try{tg?.setHeaderColor(bg);tg?.setBackgroundColor(bg);if(tg?.isVersionAtLeast?.('7.10'))tg.setBottomBarColor(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())}catch{}syncMainButton()}
function safeArea(){const top=tg?.contentSafeAreaInset?.top||0,bottom=Math.max(tg?.safeAreaInset?.bottom||0,tg?.contentSafeAreaInset?.bottom||0);document.documentElement.style.setProperty('--top',top+'px');if(bottom)document.documentElement.style.setProperty('--bottom',bottom+'px')}
function haptic(kind='selection'){try{if(kind==='selection')tg?.HapticFeedback?.selectionChanged();else tg?.HapticFeedback?.notificationOccurred(kind)}catch{}}
// action = {label, run}: кнопка в уведомлении, например «Вернуть» после отмены визита.
function toast(message,action){
  clearTimeout(toastTimer);
  const target=$('#toast');
  (dialog.open?dialog:document.body).appendChild(target);
  target.textContent=message;
  if(action){
    const b=document.createElement('button');b.type='button';b.textContent=action.label;
    b.addEventListener('click',async()=>{target.textContent='';try{await action.run()}catch(e){toast(e.message||'Не удалось выполнить действие.')}},{once:true});
    target.appendChild(b);
  }
  toastTimer=setTimeout(()=>target.textContent='',action?8000:5000);
}
const mainBtn=tg?.isVersionAtLeast?.('6.1')?tg.MainButton:null;let mainTarget=null,mainWatch=null;
// В Telegram главное действие формы переезжает в нативную кнопку внизу экрана; кнопка на странице прячется, но остаётся отправителем формы.
function syncMainButton(){if(!mainBtn)return;mainWatch?.disconnect();mainTarget?.classList.remove('tg-hidden');mainTarget=null;const b=dialog.open&&dialog.querySelector(':is(#record-form,#day-form,#settings-form,#client-note-form) [type=submit]');if(!b||b.closest('fieldset:disabled')){mainBtn.hideProgress();mainBtn.hide();return}mainTarget=b;b.classList.add('tg-hidden');const css=getComputedStyle(document.documentElement),upd=()=>{if(b.disabled)mainBtn.showProgress(false);else mainBtn.hideProgress()};mainBtn.setParams({text:b.textContent.trim(),color:css.getPropertyValue('--ink').trim(),text_color:css.getPropertyValue('--bg').trim(),is_active:true,is_visible:true});upd();mainWatch=new MutationObserver(upd);mainWatch.observe(b,{attributes:true,attributeFilter:['disabled']})}
function setBack(){if(!tg?.BackButton)return;if(dialog.open||tab!=='today')tg.BackButton.show();else tg.BackButton.hide()}
function modal(title,sub,content){if(dialog.open&&dirty&&!confirm('Закрыть текущую форму без сохранения изменений?'))return false;document.body.appendChild($('#toast'));dialog.innerHTML=`<div class="dialog-content"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button type="button" class="icon-button" data-action="close" aria-label="Закрыть">${icon('close')}</button></div>${sub?`<p class="dialog-sub">${esc(sub)}</p>`:''}${content}</div>`;dirty=false;for(const form of dialog.querySelectorAll('form'))form.dataset.revision=String(state.revision);if(!dialog.open)dialog.showModal();setBack();syncMainButton();return true}
function closeModal(){if(dirty&&!confirm('Закрыть без сохранения изменений?'))return;dirty=false;dialog.close()}
function afterClose(){document.body.appendChild($('#toast'));dirty=false;tg?.disableClosingConfirmation?.();setBack();syncMainButton()}
// Очистка сразу при закрытии из кода: событие close приходит асинхронно, а нативная кнопка Telegram должна исчезнуть немедленно.
const closeDialog=dialog.close.bind(dialog);dialog.close=v=>{closeDialog(v);afterClose()};dialog.addEventListener('close',afterClose);
dialog.addEventListener('cancel',e=>{if(dirty){e.preventDefault();closeModal()}});
dialog.addEventListener('input',e=>{if(!e.target.closest('form'))return;dirty=true;tg?.enableClosingConfirmation?.()});
dialog.addEventListener('click',e=>{const r=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))closeModal()});
async function api(path,body,retried=false){try{return await apiCall(path,body)}catch(e){if(e.status===401&&!retried&&path!=='session'&&tg?.initData){try{await apiCall('session',{initData:tg.initData})}catch{throw e}return api(path,body,true)}throw e}}
async function apiCall(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(sessionToken?{authorization:'Bearer '+sessionToken}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await response.json().catch(()=>({}));if(!response.ok){const e=Error(data.message||'Не удалось выполнить действие.');e.code=data.error;e.status=response.status;throw e}if(path==='session'&&data.session)sessionToken=data.session;return data}
let syncInfo=null;
const ago=at=>{const m=Math.max(0,Math.round((Date.now()-at)/60000));return m<1?'только что':m<60?m+' мин назад':m<1440?Math.floor(m/60)+' ч назад':Math.floor(m/1440)+' дн назад'};
async function refresh(){const data=await api('state');owner=data.owner;hasFriend=data.hasFriend;syncInfo=data.sync||null;state={revision:data.revision,records:data.records,settings:data.settings,clientNotes:data.clientNotes,dayOverrides:data.dayOverrides||{}};today=data.today;return state}
function demoValidate(r){const start=mins(r.time),end=start+r.duration,s=state.settings;if(!r.name.trim())throw Error('Укажите имя клиента.');if(!/^20\d{2}-\d{2}-\d{2}$/.test(r.date)||Number.isNaN(Date.parse(r.date+'T12:00:00Z'))||iso(parse(r.date))!==r.date)throw Error('Укажите существующую дату.');const hours=workday(state,r.date);if(hours.closed||start<mins(hours.start)||end>mins(hours.end))throw Error('Визит должен помещаться в рабочее время выбранного дня.');if(active(r)&&state.records.some(x=>x.id!==r.id&&x.date===r.date&&active(x)&&start<mins(x.time)+x.duration&&end>mins(x.time)))throw Error('Это время занято. Выберите свободное окно.')}
async function commit(path,body){
  if(demo){
    if(path==='record'){const r=body.record;demoValidate(r);r.id||=crypto.randomUUID();r.updatedAt=new Date().toISOString();state.records=state.records.filter(x=>x.id!==r.id).concat(r)}
    else if(path==='cancel')state.records.find(r=>r.id===body.id).status='cancelled';
    else if(path==='settings'){if(mins(body.settings.start)>=mins(body.settings.end))throw Error('Конец рабочего дня должен быть позже начала.');state.settings=body.settings}
    else if(path==='client-note')Object.defineProperty(state.clientNotes,body.name,{value:body.note,enumerable:true,writable:true,configurable:true});
    else if(path==='day'){
      const overrides={...state.dayOverrides};if(body.override)overrides[body.date]=body.override;else delete overrides[body.date];
      const h=workday({...state,dayOverrides:overrides},body.date);
      if(mins(h.start)>=mins(h.end))throw Error('Конец смены должен быть позже начала.');
      if(state.records.some(r=>r.date===body.date&&active(r)&&(h.closed||mins(r.time)<mins(h.start)||mins(r.time)+r.duration>mins(h.end))))throw Error('Новый график исключает существующую запись. Сначала перенесите или отмените её.');
      state.dayOverrides=overrides;
    }
    state.revision++;demoPersistent=storePreference(DEMO_KEY,JSON.stringify(state));return;
  }
  try{state=await api(path,{...body,revision:body.revision??state.revision});if(state.sync!==undefined){syncInfo=state.sync;delete state.sync}}
  catch(e){if(e.code==='CONFLICT'){await refresh();render();e.message='Данные изменились на другом устройстве. Закройте форму и откройте её заново. Введённые данные пока остаются в форме.'}throw e}
}
function heading(title,sub,add=true){return `<header class="page-head"><div><h1>${esc(title)}</h1>${sub?`<p class="sub">${esc(sub)}</p>`:''}</div><div class="head-actions"><button class="icon-button ghost head-gear" data-action="settings" aria-label="Настройки">${icon('settings')}</button>${add?`<button class="primary add" data-action="new" aria-label="Новая запись">${icon('plus')}<span>Записать</span></button>`:''}</div></header>`}
function syncNote(){
  if(demo)return `<div class="sync-banner">${icon('info')}<span>Вымышленные клиенты. Изменения сохраняются только в этом браузере.</span></div>`;
  if(syncInfo?.mode){const bad=!!syncInfo.error;return `<div class="sync-banner ${bad?'bad':'ok'}">${icon(bad?'info':'refresh')}<span>${bad?`<b>YCLIENTS: ошибка синхронизации.</b> ${esc(syncInfo.error)}`:`YCLIENTS: ${syncInfo.at?'обновлено '+ago(syncInfo.at)+', записей '+syncInfo.count:'ждём первую загрузку'}. Эти записи меняются только в YCLIENTS.`}</span><button class="text-button" data-action="sync-now">Обновить</button></div>`}
  return `<div class="sync-banner">${icon('info')}<span>Это личный план. Свободные окна не учитывают записи администратора в YCLIENTS.${owner?' Подключите календарь YCLIENTS в настройках.':''}</span></div>`;
}
function syncSettings(){
  if(demo)return '';
  const s=syncInfo||{},head=`<section class="settings-section"><h3>YCLIENTS</h3>`;
  if(s.mode==='api')return head+`<p class="help-copy">Подключено через официальный API YCLIENTS. ${s.at?'Последняя загрузка '+ago(s.at)+'.':''} ${s.error?`<span class="danger">${esc(s.error)}</span>`:''}</p><div class="settings-list"><button class="secondary" data-action="sync-now">${icon('refresh')}Синхронизировать сейчас</button></div></section>`;
  if(s.mode==='ics')return head+`<p class="help-copy">Подключён календарь <b>${esc(s.host)}</b>. ${s.at?'Последняя загрузка '+ago(s.at)+', записей: '+s.count+'.':''} ${s.error?`<br><span class="danger">${esc(s.error)}</span>`:''}</p><div class="settings-list"><button class="secondary" data-action="sync-now">${icon('refresh')}Синхронизировать сейчас</button>${owner?'<button class="secondary danger" data-action="sync-off">Отключить YCLIENTS</button>':''}</div></section>`;
  if(!owner)return head+'<p class="help-copy">Не подключено. Подключение выполняет владелец.</p></section>';
  return head+`<p class="help-copy">Записи из YCLIENTS можно подтягивать без доступа к API — через официальную выгрузку в Google Календарь:</p><ol class="steps"><li>Администратор: <b>Настройки → Сотрудники → вы → Настройки → Интеграция → Подключить Google-календарь</b>. Включите «Выгружать данные клиентов».</li><li>В Google Календаре на компьютере: настройки этого календаря → <b>«Секретный адрес в формате iCal»</b> → скопируйте.</li><li>Вставьте ссылку ниже. Её видит только сервер, в копии данных она не попадает.</li></ol><form id="sync-form" class="sync-form"><label class="field full">Секретный адрес iCal<input name="url" type="url" inputmode="url" required placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off"></label><p class="error" role="alert"></p><div class="actions"><button class="primary" type="submit">Подключить YCLIENTS</button></div></form></section>`;
}
function nav(){const items=[['today','Сегодня'],['calendar','Календарь'],['clients','Клиенты'],['stats','Обзор']];$('#navigation').hidden=false;$('#navigation').innerHTML=`<div class="nav-inner">${items.map(([id,name])=>`<button class="nav-item ${tab===id?'active':''}" data-action="tab" data-value="${id}" ${tab===id?'aria-current="page"':''}>${icon(id)}<span>${name}</span></button>`).join('')}</div>`;setBack()}
function recordsOn(d=date){return state.records.filter(r=>r.date===d).sort((a,b)=>a.time.localeCompare(b.time))}
function gaps(d=date){const s=workday(state,d);if(s.closed)return [];let cursor=mins(s.start),out=[];for(const r of recordsOn(d).filter(active)){const start=Math.max(mins(s.start),mins(r.time));if(start>cursor)out.push([cursor,Math.min(start,mins(s.end))]);cursor=Math.max(cursor,mins(r.time)+r.duration)}if(cursor<mins(s.end))out.push([cursor,mins(s.end)]);return out.filter(g=>g[1]>g[0])}
function clockNow(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:state.settings.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return Number(p.hour)*60+Number(p.minute)}
const PX=1.25; // пикселей на минуту: час = 75 px, рабочий день — около полутора экранов телефона
function appt(r,top,lane,live){
  const h=Math.max(r.duration*PX,30),end=time(mins(r.time)+r.duration),size=h<44?' xs':h<72?' sm':'',block=r.type==='block';
  const state=block?'':r.status==='confirmed'?'':labels[r.status].toLowerCase();
  return `<button class="appt ${esc(r.status)}${block?' blocked':''}${size}${live?' live':''}${lane?' lane':''}" style="top:${top}px;height:${h}px" data-action="edit" data-id="${esc(r.id)}" aria-label="${esc(`${r.time}–${end}, ${r.name}, ${r.service}${state?', '+state:''}`)}"><span class="appt-line"><b class="appt-name">${esc(block?(r.note||'Время закрыто'):r.name)}</b><span class="appt-time">${r.time}–${end}</span></span><span class="appt-meta">${block?'':esc(r.service)}${state?`<em>${state}</em>`:''}${r.source==='yclients'?'<i class="src">YCLIENTS</i>':''}</span></button>`;
}
function goneList(gone){
  if(!gone.length)return '';
  return `<details class="gone"><summary>Отмены и неявки: ${gone.length}</summary>${gone.map(r=>`<button class="gone-row" data-action="edit" data-id="${esc(r.id)}"><span class="gone-time">${r.time}</span><span>${esc(r.name)}</span><small>${labels[r.status]}</small></button>`).join('')}</details>`;
}
function ruler(){
  const hours=workday(state,date),rs=recordsOn(),live=rs.filter(active),gone=rs.filter(r=>!active(r));
  if(!live.length&&hours.closed)return `<div class="empty"><h3>Выходной</h3><p>По графику в этот день вы не работаете.</p><button class="secondary" data-action="day">Сделать день рабочим</button></div>`+goneList(gone);
  let from=hours.closed?1440:mins(hours.start),to=hours.closed?0:mins(hours.end);
  for(const r of live){from=Math.min(from,mins(r.time));to=Math.max(to,mins(r.time)+r.duration)}
  from=Math.floor(from/60)*60;to=Math.min(1440,Math.ceil(to/60)*60);
  const y=m=>Math.round((m-from)*PX),now=date===today?clockNow():-1;
  let marks='';for(let m=from;m<=to;m+=60)if(Math.abs(m-now)>=12)marks+=`<span class="hour" style="top:${y(m)}px">${time(m%1440)}</span>`;
  let half='';for(let m=from+30;m<to;m+=60)half+=`<span class="half" style="top:${y(m)}px"></span>`;
  let gapsHtml='';
  if(!hours.closed)for(let [s,e]of gaps()){
    if(now>s)s=Math.ceil(now/5)*5; // сегодня окно считается от текущего момента
    if(e-s<15)continue;
    const h=(e-s)*PX-4,label=h>=34?`Свободно ${duration(e-s)}`:'';
    gapsHtml+=`<button class="gap${h<34?' thin':''}" style="top:${y(s)+2}px;height:${h}px" data-action="free" data-value="${time(s)}" aria-label="Свободно ${time(s)}–${time(e)}. Записать клиента"><span>${label}</span>${icon('plus')}</button>`;
  }
  let lastEnd=-1,blocks='';
  for(const r of live){const s=mins(r.time);blocks+=appt(r,y(s),s<lastEnd,r.type!=='block'&&now>=s&&now<s+r.duration);lastEnd=Math.max(lastEnd,s+r.duration)}
  const nowLine=now>=from&&now<=to?`<div class="now-line" style="top:${y(now)}px" aria-hidden="true"><span>${time(now)}</span></div>`:'';
  return `<div class="ruler" style="height:${y(to)}px">${marks}${half}<div class="track">${gapsHtml}${blocks}</div>${nowLine}</div>`+goneList(gone);
}
// Карточка «Сейчас»: кто в кресле и сколько осталось, либо сколько свободно до следующего клиента.
// Полоса слева — барбер-пол: крутится, пока клиент в кресле.
function nowStrip(){
  if(date!==today)return '';
  const now=clockNow(),hours=workday(state,date),list=recordsOn().filter(r=>active(r)&&r.type!=='block');
  const cur=list.find(r=>mins(r.time)<=now&&now<mins(r.time)+r.duration),next=list.find(r=>mins(r.time)>now);
  const left=n=>n<60?[n,'мин']:[Math.floor(n/60)+':'+String(n%60).padStart(2,'0'),'ч'];
  let head,sub='',count=null,bar='',mode='idle';
  if(cur){
    const end=mins(cur.time)+cur.duration,passed=Math.round((now-mins(cur.time))/cur.duration*100);
    mode='busy';head=`<b>${esc(cur.name)}</b> в кресле`;sub=`${esc(cur.service)}, до ${time(end)}`;count=[...left(end-now),'осталось'];
    bar=`<div class="now-bar" role="img" aria-label="Прошло ${passed}% визита"><span style="width:${passed}%"></span></div>`;
  }else if(next){
    mode='free';head=`Свободно до ${next.time}`;count=mins(next.time)-now<=180?[...left(mins(next.time)-now),'до клиента']:null;
  }else if(!hours.closed&&now<mins(hours.end)){
    mode='free';head=list.length?'Клиентов больше нет':'Записей пока нет';sub=`Смена до ${hours.end}`;
  }else{
    const done=list.filter(r=>r.status==='done').length;
    head='Смена закончилась';sub=list.length?`За день ${list.length} ${plural(list.length,'визит','визита','визитов')}${done?', отмечено завершёнными: '+done:''}`:'';
  }
  const ended=list.filter(r=>r.source!=='yclients'&&mins(r.time)+r.duration<=now&&['confirmed','arrived','waiting'].includes(r.status)).pop(),mark=cur&&cur.source!=='yclients'?cur:ended;
  const g=!cur&&!hours.closed?gaps().find(([s,e])=>s<=now&&now<e):null,walk=g?Math.max(g[0],Math.floor(now/15)*15):-1;
  const after=next?`<button class="now-next" data-action="edit" data-id="${esc(next.id)}">Дальше в ${next.time} — ${esc(next.name)}${cur?'':', '+esc(next.service)}</button>`:'';
  const opts=mark===cur?[['arrived','Пришёл'],['done','Завершён'],['noshow','Не пришёл']]:[['done','Завершён'],['noshow','Не пришёл']];
  const ask=mark&&mark!==cur?`<p class="now-mark">Как прошёл визит: ${mark.time}, ${esc(mark.name)}?</p>`:'';
  const quick=mark||walk>=0&&g[1]-walk>=15?`${ask}<div class="quick">${mark?opts.map(([k,l])=>`<button type="button" class="chip${mark.status===k?' on':''}" data-action="quick-status" data-id="${esc(mark.id)}" data-value="${k}">${l}</button>`).join(''):''}${walk>=0&&g[1]-walk>=15?`<button type="button" class="chip add-now" data-action="free" data-value="${time(walk)}">${icon('plus')}Записать на ${time(walk)}</button>`:''}</div>`:'';
  const counter=count?`<p class="now-count"><b class="num">${count[0]}</b><span>${count[1]} ${count[2]}</span></p>`:'';
  return `<section class="now ${mode}" aria-label="Сейчас"><i class="pole" aria-hidden="true"></i><div class="now-main"><div class="now-text"><p class="now-head">${head}</p>${sub?`<p class="now-sub">${sub}</p>`:''}${after}</div>${counter}</div>${bar}${quick}</section>`;
}
let scrollKey='';
function schedule(){
  const hours=workday(state,date),live=recordsOn().filter(active),visits=live.filter(r=>r.type!=='block'),total=visits.reduce((n,r)=>n+r.duration,0),free=gaps().reduce((n,g)=>n+g[1]-g[0],0),cap=hours.closed?0:mins(hours.end)-mins(hours.start),load=cap?Math.min(100,Math.round(total/cap*100)):0,monday=shift(date,-((parse(date).getUTCDay()+6)%7));
  const cash=visits.reduce((n,r)=>n+(r.price||0),0);
  const title=date===today?'Сегодня':fmt(date,{day:'numeric',month:'long'}),sub=date===today?fmt(date,{weekday:'long',day:'numeric',month:'long'}):fmt(date,{weekday:'long'});
  const weekBar=`<nav class="week-bar" aria-label="Неделя"><button class="icon-button ghost" data-action="week" data-value="-7" aria-label="Предыдущая неделя">${icon('left')}</button><div class="week">${Array.from({length:7},(_,i)=>{const d=shift(monday,i),busy=recordsOn(d).some(x=>active(x)&&x.type!=='block'),off=workday(state,d).closed;return `<button class="day${d===date?' selected':''}${d===today?' today':''}${off?' off':''}" data-action="date" data-value="${d}" aria-label="${esc(fmt(d,{weekday:'long',day:'numeric',month:'long'}))}" aria-pressed="${d===date}"><small>${fmt(d,{weekday:'short'})}</small><b class="num">${parse(d).getUTCDate()}</b><i class="pip${busy?' on':''}"></i></button>`}).join('')}</div><button class="icon-button ghost" data-action="week" data-value="7" aria-label="Следующая неделя">${icon('right')}</button></nav>`;
  const tools=`<div class="tools"><div class="segmented" role="group" aria-label="Вид расписания"><button class="${view==='day'?'selected':''}" data-action="view" data-value="day" aria-pressed="${view==='day'}">День</button><button class="${view==='week'?'selected':''}" data-action="view" data-value="week" aria-pressed="${view==='week'}">Неделя</button></div><button class="text-button day-hours" data-action="day" aria-label="График этого дня">${hours.closed?'Выходной':hours.start+'–'+hours.end}${hours.overridden?' (особый)':''}</button><button class="text-button" data-action="block">Закрыть время</button></div>`;
  // В сводке время коротко, как на счётчике карточки «Сейчас»: «3:30 ч» помещается в четверть ширины телефона.
  const span=n=>n<60?n+' мин':n%60?Math.floor(n/60)+':'+String(n%60).padStart(2,'0')+' ч':n/60+' ч';
  const cell=(label,value)=>`<div><dt>${label}</dt><dd class="num">${value}</dd></div>`;
  const summary=`<aside class="aside"><dl class="summary">${cell('Визитов',visits.length)}${cell('Занято',span(total))}${cell('Свободно',span(free))}${cash?cell('Касса дня',money(cash)):cell('Загрузка',load+'%')}</dl><div class="progress" role="img" aria-label="Загрузка дня ${load}%"><span style="width:${load}%"></span></div></aside>`;
  const actions=`<div class="day-actions">${date>=today&&!hours.closed?`<button class="secondary" data-action="share-free">${icon('share')}Поделиться окнами</button>`:''}<button class="icon-button" data-action="refresh" aria-label="Обновить план">${icon('refresh')}</button></div>`;
  main.innerHTML=heading(title,sub)+weekBar+tools+
  (view==='week'?weekView(monday):`<div class="columns"><div class="col-now">${nowStrip()}</div>${summary}<section class="col-ruler" aria-label="Расписание дня">${ruler()}${actions}</section></div>`)+syncNote();
  const key=view+'|'+date;if(key!==scrollKey){scrollKey=key;if(view==='day'&&date===today)setTimeout(()=>{const t=$('.now-line')||$('.appt');if(t){const s=$('.now');let y=t.getBoundingClientRect().top+scrollY-innerHeight*.6;if(s)y=Math.min(y,s.getBoundingClientRect().top+scrollY-12);if(y>0)scrollTo(0,y)}},0)}
}
function weekView(start){return `<section class="week-list" aria-label="План на неделю">${Array.from({length:7},(_,i)=>{const d=shift(start,i),rs=recordsOn(d).filter(r=>active(r)&&r.type!=='block');return `<button class="week-row ${d===today?'today':''}" data-action="date" data-value="${d}"><span><b>${parse(d).getUTCDate()}</b><small>${fmt(d,{weekday:'short'})}</small></span><span><strong>${rs.length?rs.length+' '+plural(rs.length,'визит','визита','визитов'):'Нет визитов'}</strong><small>${rs.length?esc(rs.map(r=>r.time).join(', ')):!workday(state,d).closed?'Свободно по личному плану':'Выходной'}</small></span>${icon('right')}</button>`}).join('')}</section>`}
function calendar(){const first=month+'-01',d=parse(first),offset=(d.getUTCDay()+6)%7,days=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();main.innerHTML=heading('Календарь','Ваша смена — день за днём.')+`<section class="calendar" aria-label="Календарь записей"><div class="month-head"><button class="icon-button" data-action="month" data-value="-1" aria-label="Предыдущий месяц">${icon('left')}</button><h2>${fmt(first,{month:'long',year:'numeric'})}</h2><button class="icon-button" data-action="month" data-value="1" aria-label="Следующий месяц">${icon('right')}</button></div><div class="calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<span class="weekday">${x}</span>`).join('')}${'<span></span>'.repeat(offset)}${Array.from({length:days},(_,i)=>{const s=month+'-'+String(i+1).padStart(2,'0'),n=recordsOn(s).filter(r=>active(r)&&r.type!=='block').length;return `<button class="calendar-day ${s===date?'selected':''} ${s===today?'today':''} ${!workday(state,s).closed?'':'off'}" data-action="date" data-value="${s}" aria-label="${esc(fmt(s,{day:'numeric',month:'long'}))}, ${n} ${plural(n,'визит','визита','визитов')}" aria-pressed="${s===date}">${i+1}<span class="${n?'dot':''}" style="height:5px"></span></button>`}).join('')}</div><p class="inline-hint">Точкой отмечены дни с визитами в личном плане.</p></section>`+syncNote()}
// ---------- Клиенты ----------
let segment='all',period=7;
const HUES=[172,205,28,262,340,95];
function avatar(name,big=false){let h=0;for(const c of name)h=(h*31+c.codePointAt(0))>>>0;return `<span class="avatar${big?' big':''}" style="--h:${HUES[h%HUES.length]}">${esc(name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase())}</span>`}
const since=n=>n===0?'сегодня':n===1?'вчера':n<14?n+' '+plural(n,'день','дня','дней')+' назад':n<60?Math.round(n/7)+' нед. назад':Math.round(n/30)+' мес. назад';
const ACC={понедельник:'понедельник',вторник:'вторник',среда:'среду',четверг:'четверг',пятница:'пятницу',суббота:'субботу',воскресенье:'воскресенье'};
// День в винительном падеже без предлога: «сегодня», «завтра», «среду, 11 ноября».
const dayAcc=d=>d===today?'сегодня':d===shift(today,1)?'завтра':ACC[fmt(d,{weekday:'long'})]+', '+fmt(d,{day:'numeric',month:'long'});
const whenDay=d=>{const s=dayAcc(d);return d===today||d===shift(today,1)?s:(s.startsWith('вторник')?'во ':'в ')+s};
function clientLine(c){
  if(c.next)return `Придёт ${whenDay(c.next.date)} в ${c.next.time}`;
  if(c.last)return `Был ${since(c.daysSince)}, всего ${c.visits} ${plural(c.visits,'визит','визита','визитов')}`;
  return c.noshow?'Не пришёл на запись':'Визитов пока не было';
}
function clients(){
  const all=clientSummaries(state,today);
  main.innerHTML=heading('Клиенты',`${all.length} ${plural(all.length,'клиент','клиента','клиентов')} в вашем плане.`)+`<label><span class="visually-hidden">Поиск клиента</span><input class="search" id="client-search" type="search" placeholder="Найти по имени или телефону" autocomplete="off" value="${esc(query)}"></label><div id="client-results"></div>`+syncNote();
  clientResults();
}
function clientResults(){
  const all=clientSummaries(state,today),q=query.trim().toLocaleLowerCase('ru'),digits=q.replace(/\D/g,'');
  const groups={all,soon:all.filter(c=>c.next),lost:all.filter(isLost),fresh:all.filter(c=>isNew(c,today))};
  if(!groups[segment])segment='all';
  const order={lost:(a,b)=>b.daysSince-a.daysSince,soon:(a,b)=>(a.next.date+a.next.time).localeCompare(b.next.date+b.next.time)}[segment]||((a,b)=>a.name.localeCompare(b.name,'ru'));
  const shown=groups[segment].filter(c=>!q||c.name.toLocaleLowerCase('ru').includes(q)||digits.length>=3&&phoneDigits(c.phone).includes(digits)).sort(order);
  const chips=`<div class="quick segments" role="group" aria-label="Группа клиентов">${[['all','Все'],['soon','С записью'],['lost','Давно не были'],['fresh','Новые']].map(([id,label])=>`<button type="button" class="chip${segment===id?' on':''}" data-action="segment" data-value="${id}" aria-pressed="${segment===id}">${label}<span class="chip-n">${groups[id].length}</span></button>`).join('')}</div>`;
  const empty={all:['Здесь будут ваши клиенты','Клиенты появятся после первой записи.'],soon:['Никто не записан','Клиенты с будущей записью появятся здесь.'],lost:['Все на месте','Сюда попадают клиенты, которые не приходили больше шести недель и не записаны.'],fresh:['Новых клиентов нет','Здесь видны те, кто впервые записался за последние 30 дней.']}[segment];
  $('#client-results').innerHTML=chips+(shown.length?`<div class="client-list">${shown.map(c=>`<button class="client" data-action="client" data-name="${esc(c.name)}">${avatar(c.name)}<span class="client-meta"><b>${esc(c.name)}</b><small>${esc(clientLine(c))}</small></span>${isLost(c)?'<span class="tag">давно не был</span>':''}${icon('right')}</button>`).join('')}</div>`:`<div class="empty"><h3>${q?'Клиент не найден':empty[0]}</h3><p>${q?'Попробуйте другое имя или номер.':empty[1]}</p></div>`);
}
// Ссылки для связи. В Telegram их открывает сам клиент Telegram (см. обработчик a[data-ext]).
const phoneOf=r=>r.phone||state.records.findLast(x=>x.type!=='block'&&x.name===r.name&&x.phone)?.phone||'';
function contacts(phone){
  const d=phoneDigits(phone);if(!d)return '';
  return `<div class="quick contacts" role="group" aria-label="Связаться с клиентом"><a class="chip" href="tel:+${d}">${icon('phone')}Позвонить</a><a class="chip" data-ext target="_blank" rel="noopener" href="https://wa.me/${d}">WhatsApp</a><a class="chip" data-ext target="_blank" rel="noopener" href="https://t.me/+${d}">Telegram</a></div>`;
}
function clientCard(name){
  const c=clientSummaries(state,today).find(x=>x.name===name);if(!c)return;
  const rs=state.records.filter(r=>r.type!=='block'&&r.name===name).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time)),note=Object.hasOwn(state.clientNotes,name)?state.clientNotes[name]:'';
  const weeks=Math.round(c.interval/7),rhythm=c.interval?(c.interval<11?`Ходит раз в ${c.interval} ${plural(c.interval,'день','дня','дней')}`:`Ходит раз в ${weeks} ${plural(weeks,'неделю','недели','недель')}`):c.visits?'Был один раз':'Ещё не был';
  const sub=rhythm+(c.next?`, придёт ${whenDay(c.next.date)} в ${c.next.time}`:isLost(c)?', давно не был':'')+(c.phone?'. '+c.phone:'');
  const cell=(label,value)=>`<div><dt>${label}</dt><dd class="num">${value}</dd></div>`;
  modal(name,sub,`<dl class="client-stats">${cell('Визитов',c.visits)}${cell('Оставил',money(c.spent))}${cell('Не пришёл',c.noshow)}</dl>${contacts(c.phone)}<div class="pair"><button class="secondary" data-action="new-client" data-name="${esc(name)}">${icon('plus')}Записать</button><button class="secondary" data-action="message-client" data-name="${esc(name)}">${icon('message')}Написать</button></div><form id="client-note-form" data-name="${esc(name)}" class="client-note"><label class="field">Заметка о клиенте<textarea name="note" maxlength="1000" placeholder="Предпочтения по стрижке">${esc(note)}</textarea></label><button class="text-button" type="submit">Сохранить заметку</button><p class="error" role="alert"></p></form><h3>История записей</h3><div class="history">${rs.map(r=>`<button class="history-item" data-action="edit" data-id="${esc(r.id)}"><strong>${esc(fmt(r.date,{day:'numeric',month:'long',year:'numeric'}))}, ${r.time}</strong><small>${esc(r.service)}, ${labels[r.status].toLowerCase()}${r.price?', '+money(r.price):''}</small></button>`).join('')}</div>`);
}

// ---------- Тексты для клиентов: свободные окна и напоминания ----------
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
// Свободное время на days дней начиная с from — готовый текст для чата или сторис.
function freeText(from,days,length){
  const lines=[],start=from<today?today:from;
  for(let i=0;i<days;i++){
    const d=shift(start,i),slots=slotStarts(state,d,length,d===today?Math.ceil(clockNow()/15)*15:0);
    if(slots?.length)lines.push([d,slots]);
  }
  if(!lines.length)return days===1?'На этот день свободных окон нет.':'На эти дни свободных окон нет.';
  const body=days===1?`Свободные окна на ${dayAcc(lines[0][0])}:\n${lines[0][1].join(', ')}`:'Свободные окна:\n'+lines.map(([d,slots])=>`${cap(fmt(d,{weekday:'short'}))}, ${fmt(d,{day:'numeric',month:'long'})}: ${slots.join(', ')}`).join('\n');
  return body+'\n\nНапишите, какое время вам удобно.';
}
function recordMessage(r){return `Здравствуйте, ${r.name.trim().split(/\s+/)[0]}! Напоминаю о записи ${whenDay(r.date)} в ${r.time} — ${r.service.toLowerCase()}. Если планы изменились, напишите, пожалуйста.`}
function clientMessage(c){
  if(c.next)return recordMessage(c.next);
  const length=state.settings.services.find(s=>s.name===c.service)?.duration||60,free=freeText(today,7,length);
  return `Здравствуйте, ${c.name.trim().split(/\s+/)[0]}! Давно не виделись. Если пора обновить стрижку — запишу на удобное время.`+(free.startsWith('Свободные')?'\n\n'+free:'');
}
let shareFrom=null;
function shareDialog(title,sub,text,{phone='',controls=''}={}){
  const d=phoneDigits(phone);
  return modal(title,sub,`${controls}<label class="field full">Текст сообщения<textarea id="share-text" rows="7" maxlength="2000">${esc(text)}</textarea></label><p class="inline-hint">Текст можно поправить перед отправкой. Сообщение уходит от вашего имени — «Смена» сама клиентам не пишет.</p><div class="actions wrap"><button class="primary" type="button" data-action="share-send">${icon('share')}Отправить</button>${d?`<button class="secondary" type="button" data-action="share-wa" data-value="${d}">WhatsApp</button>`:''}<button class="secondary" type="button" data-action="share-copy">Скопировать</button></div>`);
}
function shareFree(){
  shareFrom=date;const s=state.settings.services;
  const controls=`<div class="fields share-controls"><label class="field">Услуга<select id="share-service">${options(s.map(x=>[x.duration,`${x.name}, ${duration(x.duration)}`]),s[0].duration)}</select></label><label class="field">Период<select id="share-days">${options([[1,'Только этот день'],[3,'3 дня'],[7,'Неделя']],1)}</select></label></div>`;
  shareDialog('Свободные окна',cap(fmt(date<today?today:date,{weekday:'long',day:'numeric',month:'long'})),freeText(date,1,s[0].duration),{controls});
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text);return true}
  catch{const area=$('#share-text');if(!area)return false;area.focus();area.select();try{return document.execCommand('copy')}catch{return false}}
}
async function sendText(text){
  if(navigator.share){try{await navigator.share({text});return}catch(e){if(e.name==='AbortError')return}}
  toast(await copyText(text)?'Текст скопирован — вставьте его в чат с клиентом':'Выделите текст и скопируйте его вручную');
}

// ---------- Обзор ----------
function stats(){
  const n=period,from=shift(today,-(n-1)),cur=periodStats(state,from,today),prev=periodStats(state,shift(from,-n),shift(from,-1)),ahead=periodStats(state,shift(today,1),shift(today,7));
  const byMoney=cur.revenue>0||prev.revenue>0,value=byMoney?cur.revenue:cur.done,before=byMoney?prev.revenue:prev.done,show=v=>byMoney?money(v):String(v);
  // Сравнение имеет смысл, только когда прошлый период сопоставим: иначе получаются «+15000%».
  const raw=before?Math.round((value-before)/before*100):null,delta=raw!==null&&raw>300?null:raw;
  const trend=delta===null?'':delta===0?`Столько же, сколько за предыдущие ${n} дней`:`<b class="${delta>0?'up':'down'}">${delta>0?'+':'−'}${Math.abs(delta)}%</b> к предыдущим ${n} дням`;
  // Столбики: по дням, а для 90 дней — по неделям.
  let bars=cur.byDay.map(d=>({from:d.date,to:d.date,v:byMoney?d.revenue:d.count}));
  if(n===90){const weeks=[];for(let i=bars.length;i>0;i-=7){const part=bars.slice(Math.max(0,i-7),i);weeks.unshift({from:part[0].from,to:part.at(-1).to,v:part.reduce((s,b)=>s+b.v,0)})}bars=weeks}
  const max=Math.max(1,...bars.map(b=>b.v)),range=b=>b.from===b.to?fmt(b.from,{day:'numeric',month:'long'}):fmt(b.from,{day:'numeric',month:'short'})+' — '+fmt(b.to,{day:'numeric',month:'short'});
  const chart=`<div class="bars n${n}" role="img" aria-label="${esc(bars.map(b=>range(b)+': '+show(b.v)).join('; '))}">${bars.map(b=>`<div class="bar-column${b.to===today?' cur':''}">${n===7?`<span class="num">${b.v>=1000?(b.v/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})+'к':b.v}</span>`:''}<div class="bar-box"><div class="bar${b.v?'':' zero'}" style="height:${Math.max(2,Math.round(b.v/max*100))}%"></div></div>${n===7?`<span>${fmt(b.from,{weekday:'short'})}</span>`:''}</div>`).join('')}</div>${n===7?'':`<p class="bar-range"><span>${fmt(from,{day:'numeric',month:'long'})}</span><span>${fmt(today,{day:'numeric',month:'long'})}</span></p>`}`;
  const cell=(label,v,hint='')=>`<div class="metric"><small>${label}</small><strong class="num">${v}</strong>${hint?`<span>${hint}</span>`:''}</div>`;
  const top=cur.services.slice(0,5),topMax=Math.max(1,...top.map(s=>s.count));
  const services=top.length?`<section class="panel"><h2>Услуги</h2><div class="rank">${top.map(s=>`<div class="rank-row"><p><span>${esc(s.name)}${s.revenue?` <small>${s.count} ${plural(s.count,'визит','визита','визитов')}</small>`:''}</span><b class="num">${s.revenue?money(s.revenue):s.count}</b></p><div class="rank-bar"><span style="width:${Math.round(s.count/topMax*100)}%"></span></div></div>`).join('')}</div></section>`:'';
  const lost=clientSummaries(state,today).filter(isLost).sort((a,b)=>a.daysSince-b.daysSince);
  const people=`<section class="panel"><h2>Клиенты</h2><p class="sub">За период — ${cur.clients} ${plural(cur.clients,'клиент','клиента','клиентов')}${cur.newClients?', из них новых: '+cur.newClients:''}.</p>${lost.length?`<h3 class="panel-sub">Пора позвать снова</h3><div class="client-list">${lost.slice(0,4).map(c=>`<button class="client" data-action="client" data-name="${esc(c.name)}">${avatar(c.name)}<span class="client-meta"><b>${esc(c.name)}</b><small>${esc(clientLine(c))}</small></span>${icon('right')}</button>`).join('')}</div>${lost.length>4?`<button class="text-button" data-action="show-lost">Все, кто давно не был: ${lost.length}</button>`:''}`:''}</section>`;
  const coming=`<section class="panel ahead"><div><h2>Впереди 7 дней</h2><p class="sub">${ahead.planned?`${ahead.planned} ${plural(ahead.planned,'визит','визита','визитов')} уже в плане`:'Записей пока нет'}</p></div>${ahead.expected?`<p class="ahead-sum num">${money(ahead.expected)}</p>`:''}</section>`;
  main.innerHTML=heading('Обзор',`${fmt(from,{day:'numeric',month:'long'})} — ${fmt(today,{day:'numeric',month:'long'})}`,false)+
    `<div class="segmented period" role="group" aria-label="Период">${[7,30,90].map(x=>`<button class="${n===x?'selected':''}" data-action="period" data-value="${x}" aria-pressed="${n===x}">${x} дней</button>`).join('')}</div>`+
    `<section class="panel hero"><p class="hero-label">${byMoney?'Выручка':'Завершённые визиты'}</p><p class="hero-value num">${show(value)}</p>${trend?`<p class="hero-trend">${trend}</p>`:''}${chart}</section>`+
    `<div class="metric-row">${cell('Завершено',cur.done)}${byMoney?cell('Средний чек',money(cur.avgCheck)):cell('С клиентами',duration(cur.minutes))}${cell('Загрузка',cur.load+'%')}${cell('Неявки',cur.noshow,cur.noshow?cur.noshowRate+'% визитов':'')}</div>`+
    coming+services+people+
    `<p class="inline-hint">${byMoney?'Выручка — сумма цен завершённых визитов. Это не расчёт зарплаты и не данные кассы. ':''}Загрузка считается по рабочему графику.</p>`+syncNote();
}
// Смена экрана с коротким переходом там, где браузер это умеет; иначе — мгновенно.
function go(update,dir=''){
  if(!document.startViewTransition||matchMedia('(prefers-reduced-motion: reduce)').matches){update();return}
  document.documentElement.dataset.dir=dir;document.startViewTransition(update);
}
function render(){if(!state)return;nav();if(tab!=='today')scrollKey='';if(tab==='today')schedule();else if(tab==='calendar')calendar();else if(tab==='clients')clients();else stats()}
function options(items,value){return items.map(([v,label])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(label)}</option>`).join('')}
function editor(id,start,name,block=false,pre={}){
  const nextEditing=id||null;const r=state.records.find(r=>r.id===id),available=gaps().find(g=>g[0]===mins(start||''));const fitting=available?state.settings.services.filter(s=>s.duration<=available[1]-available[0]):state.settings.services;const known=state.settings.services.find(s=>s.name===pre.service);const service=known||(fitting.length?fitting:state.settings.services)[0];const day=pre.date||date;const v=r||{name:name||'',service:service.name,date:day,time:start||time(gaps(day).find(g=>g[1]-g[0]>=service.duration)?.[0]??mins(workday(state,day).start)),duration:service.duration,status:'confirmed',note:'',phone:pre.phone||'',price:service.price,type:block?'block':'visit'};block=v.type==='block';
  const quick=r&&!block&&r.source!=='yclients'&&active(r)?`<div class="quick" role="group" aria-label="Быстрый статус">${[['arrived','Пришёл'],['done','Завершён'],['noshow','Не пришёл']].map(([k,l])=>`<button type="button" class="chip ${r.status===k?'on':''}" data-action="quick-status" data-id="${esc(r.id)}" data-value="${k}">${l}</button>`).join('')}</div>`:'';
  const repeat=r&&!block?`<button type="button" class="text-button" data-action="repeat" data-id="${esc(r.id)}">${icon('refresh')} Записать снова через 4 недели</button>`:'';
  // Связаться с клиентом прямо из записи: звонок, мессенджер или готовый текст напоминания.
  const reach=r&&!block?`${contacts(phoneOf(r))}${active(r)&&r.date>=today?`<button type="button" class="text-button reach" data-action="message-record" data-id="${esc(r.id)}">${icon('message')} Напомнить клиенту о визите</button>`:''}`:'';
  const ro=r?.source==='yclients';const form=`${quick}${reach}<form id="record-form" data-type="${block?'block':'visit'}"><fieldset class="plain" ${ro?'disabled':''}><div class="fields">${!block?`<label class="field full">Клиент<input name="name" required maxlength="80" autocomplete="off" placeholder="Имя и фамилия" list="client-names" value="${esc(v.name)}"></label><datalist id="client-names">${[...new Set(state.records.filter(x=>x.type!=='block').map(x=>x.name))].map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist><label class="field full">Услуга<select name="service">${options([...new Set(state.settings.services.map(s=>s.name).concat(v.service))].map(s=>[s,s]),v.service)}</select></label>`:''}<label class="field">Дата<input name="date" type="date" required value="${v.date}"></label><label class="field">Время<input name="time" type="time" step="300" required value="${v.time}"></label><label class="field">Длительность<select name="duration">${options([...new Set([15,30,45,60,90,120,150,180,240,300,360,420,480,v.duration])].sort((a,b)=>a-b).map(n=>[n,duration(n)]),v.duration)}</select></label><label class="field">${block?'Статус времени':'Статус визита'}<select name="status">${options(Object.entries(labels).filter(([k])=>!block||['confirmed','cancelled'].includes(k)),v.status)}</select></label>${!block?`<label class="field">Телефон<input name="phone" type="tel" maxlength="40" autocomplete="tel" placeholder="Необязательно" value="${esc(v.phone)}"></label><label class="field">Цена, ₽<input name="price" type="number" inputmode="decimal" min="0" max="1000000" step="any" placeholder="0" value="${Number(v.price)}"></label>`:''}<label class="field full">Заметка<textarea name="note" maxlength="1000" placeholder="${block?'Например: обед или личные дела':'Предпочтения клиента или детали визита'}">${esc(v.note)}</textarea></label></div></fieldset><p class="error" id="form-error" role="alert"></p>${ro?'<p class="inline-hint">Запись из YCLIENTS. Изменить или отменить её можно только в YCLIENTS.</p>':`<div class="actions"><button class="primary" type="submit">${block?'Закрыть время':'Сохранить запись'}</button></div>`}${!ro&&r&&active(r)?`<button type="button" class="text-button danger" data-action="cancel-ask">${block?'Освободить время':'Отменить визит'}</button>`:''}${repeat}<div id="cancel-confirm"></div></form>`;
  if(!modal(block?'Закрытое время':r?'Запись клиента':'Новая запись',demo?'Тестовые данные. YCLIENTS не подключён.':'Изменение личного плана. В YCLIENTS запись не появится.',form))return;editing=nextEditing;if(!r&&!block)$('#record-form [name=name]').focus();
}
async function submitRecord(form){const data=new FormData(form),block=form.dataset.type==='block';const r={...(editing?{id:editing}:{}),name:block?'Время закрыто':String(data.get('name')).trim(),service:block?'Перерыв':data.get('service'),date:data.get('date'),time:data.get('time'),duration:Number(data.get('duration')),status:data.get('status'),note:data.get('note'),phone:block?'':data.get('phone'),price:block?0:Number(data.get('price')),type:block?'block':'visit'};await commit('record',{record:r,revision:Number(form.dataset.revision)});date=r.date;month=date.slice(0,7);tab='today';view='day';dirty=false;dialog.close();render();haptic('success');toast(demo?(demoPersistent?'Запись сохранена в демоверсии':'Сохранено до закрытия вкладки: браузер не разрешил хранение'):'Сохранено в личном плане')}
function serviceRow(s,i){return `<div class="service-editor" data-service><div class="service-top"><label class="field">Название услуги<input name="service-name" maxlength="80" required value="${esc(s.name)}" aria-label="Название услуги ${i+1}"></label><button type="button" class="icon-button danger" data-action="remove-service" aria-label="Удалить услугу ${i+1}">${icon('close')}</button></div><div class="fields"><label class="field">Длительность, мин<input name="service-duration" type="number" min="15" max="480" step="15" required value="${s.duration}"></label><label class="field">Цена, ₽<input name="service-price" type="number" min="0" max="1000000" step="0.01" required value="${s.price}"></label></div></div>`}
function settings(){const s=state.settings,zones=[['Europe/Moscow','Москва (UTC+3)'],['Asia/Yekaterinburg','Екатеринбург (UTC+5)'],['Asia/Omsk','Омск (UTC+6)'],['Asia/Novosibirsk','Новосибирск (UTC+7)'],['Asia/Krasnoyarsk','Красноярск (UTC+7)'],['Asia/Irkutsk','Иркутск (UTC+8)'],['Asia/Vladivostok','Владивосток (UTC+10)']];if(!zones.some(([z])=>z===s.timeZone))zones.push([s.timeZone,s.timeZone]);modal('Настройки','График, услуги и напоминания — под ваш рабочий день.',`<form id="settings-form"><section class="settings-section" style="margin-top:0"><h3>Рабочее время</h3><div class="fields"><label class="field">Начало<input name="start" type="time" step="900" required value="${s.start}"></label><label class="field">Конец<input name="end" type="time" step="900" required value="${s.end}"></label><label class="field full">Часовой пояс<select name="timeZone">${options(zones,s.timeZone)}</select></label></div><div class="workdays">${[[1,'Пн'],[2,'Вт'],[3,'Ср'],[4,'Чт'],[5,'Пт'],[6,'Сб'],[0,'Вс']].map(([v,n])=>`<label class="workday">${n}<input name="workday" type="checkbox" value="${v}" ${s.workdays.includes(v)?'checked':''} aria-label="Рабочий день: ${n}"></label>`).join('')}</div><p class="inline-hint">График применяется к новым и изменяемым записям. Старые записи сохранятся.</p></section><section class="settings-section"><h3>Напоминания вам в Telegram</h3><label class="switch-row">Перед визитом<input name="reminders" type="checkbox" ${s.reminders?'checked':''}></label><label class="field">За сколько минут<select name="reminderMinutes">${options([15,30,60,120].map(n=>[n,n+' минут']),s.reminderMinutes||30)}</select></label><label class="switch-row">План на день утром<input name="morning" type="checkbox" ${s.morning?'checked':''}></label><label class="field">Время утреннего сообщения<input name="morningTime" type="time" required value="${s.morningTime}"></label><p class="inline-hint">${demo?'В демоверсии сообщения не отправляются.':'Напоминания отправляются подруге после выдачи доступа. До этого — владельцу бота. Нужен работающий сервер.'}</p></section><section class="settings-section"><h3>Ваши услуги</h3><div id="service-rows">${s.services.map(serviceRow).join('')}</div><button type="button" class="text-button" data-action="add-service">Добавить услугу</button></section><label class="field">Оформление<select id="theme-choice">${options([['auto','Как в Telegram / системе'],['light','Светлое'],['dark','Тёмное']],readPreference('smena-theme','auto'))}</select></label><p class="error" role="alert"></p><div class="actions"><button class="primary" type="submit">Сохранить настройки</button></div></form><section class="settings-section"><h3>Данные и доступ</h3><div class="settings-list"><button class="secondary" data-action="export">${icon('download')}Скачать резервную копию</button><button class="secondary" data-action="export-csv">${icon('download')}Записи для Excel (CSV)</button>${!demo?'<input id="backup-file" class="visually-hidden" type="file" accept="application/json,.json" aria-label="Выберите резервную копию"><button class="secondary" data-action="import-open">Восстановить из файла</button><button class="secondary" data-action="copies">Копии перед восстановлением</button>':''}${demo?'<button class="secondary" data-action="reset-ask">Восстановить демоданные</button><a class="secondary" href="/">Вернуться к личному плану</a>':owner?`<button class="secondary" data-action="${hasFriend?'revoke-ask':'invite'}">${icon('lock')}${hasFriend?'Закрыть доступ подруге':'Пригласить подругу'}</button>`:''}</div><div id="access-result"></div></section>${syncSettings()}<p class="inline-hint">Смена 0.5. ${demo?'Демонстрация на вымышленных данных':'Доступ проверяется сервером через Telegram'}</p>`)}
async function submitSettings(form){const data=new FormData(form),services=$$('[data-service]').map(row=>({name:row.querySelector('[name=service-name]').value.trim(),duration:Number(row.querySelector('[name=service-duration]').value),price:Number(row.querySelector('[name=service-price]').value)}));if(!services.length)throw Error('Оставьте хотя бы одну услугу.');if(new Set(services.map(s=>s.name)).size!==services.length)throw Error('Названия услуг должны отличаться.');const s={timeZone:data.get('timeZone'),start:data.get('start'),end:data.get('end'),workdays:data.getAll('workday').map(Number),reminders:data.has('reminders'),reminderMinutes:Number(data.get('reminderMinutes')),morning:data.has('morning'),morningTime:data.get('morningTime'),services};await commit('settings',{settings:s,revision:Number(form.dataset.revision)});today=localToday(s.timeZone);dirty=false;dialog.close();render();toast('Настройки сохранены')}
function download(){const blob=new Blob([JSON.stringify({format:'smena-v2',exportedAt:new Date().toISOString(),...state},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='smena-backup-'+today+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Резервная копия подготовлена')}

function daySettings(){
  const h=workday(state,date);
  modal('График дня',fmt(date,{weekday:'long',day:'numeric',month:'long'}),`<form id="day-form" data-date="${date}"><label class="switch-row">Выходной день<input type="checkbox" name="closed" ${h.closed?'checked':''}></label><div class="fields"><label class="field">Начало<input type="time" name="start" step="900" required value="${h.start}"></label><label class="field">Конец<input type="time" name="end" step="900" required value="${h.end}"></label></div><p class="inline-hint">Изменится только эта дата. Уже записанные клиенты должны помещаться в новый график.</p><p class="error" role="alert"></p><div class="actions"><button type="submit" class="primary">Сохранить график дня</button></div>${h.overridden?'<button type="button" class="text-button" data-action="day-reset">Вернуть общий график</button>':''}</form>`);
}
async function submitDay(form){
  const f=form.elements;
  await commit('day',{date:form.dataset.date,override:{closed:f.closed.checked,start:f.start.value,end:f.end.value},revision:Number(form.dataset.revision)});
  dirty=false;dialog.close();render();toast('График дня сохранён');
}
async function resetDay(){
  const form=$('#day-form');
  await commit('day',{date:form.dataset.date,override:null,revision:Number(form.dataset.revision)});
  dirty=false;dialog.close();render();toast('Общий график восстановлен');
}
async function previewImport(file){
  if(!file)return;
  if(file.size>24*1024*1024)throw Error('Копия слишком большая. Максимум — 24 МБ.');
  let backup;try{backup=JSON.parse(await file.text())}catch{throw Error('Не удалось прочитать JSON. Выберите резервную копию «Смены».')}
  const preview=await api('import-preview',{backup});
  const accepted=modal('Восстановление копии',file.name,`<div class="restore-summary"><strong>${preview.records}</strong><span>записей</span><strong>${preview.clients}</strong><span>клиентов</span></div>${preview.firstDate?`<p class="inline-hint">С ${esc(fmt(preview.firstDate,{day:'numeric',month:'long',year:'numeric'}))} по ${esc(fmt(preview.lastDate,{day:'numeric',month:'long',year:'numeric'}))}.</p>`:''}<div class="confirm">Копия заменит записи, заметки и настройки личного плана. Перед заменой сервер сохранит текущие данные: их можно будет вернуть. Доступ к боту останется прежним. В YCLIENTS ничего не изменится.</div><p class="error" id="restore-error" role="alert"></p><div class="actions"><button class="primary" data-action="import-confirm">Заменить личный план</button></div>`);
  if(accepted){pendingImport=backup;pendingImportRevision=state.revision}
}
async function finishImport(){
  if(!pendingImport)return;
  busy=true;const button=$('[data-action="import-confirm"]');button.disabled=true;
  try{await commit('import',{backup:pendingImport,revision:pendingImportRevision});pendingImport=null;afterRestore()}
  catch(e){$('#restore-error').textContent=e.message}
  finally{busy=false;button.disabled=false}
}
function afterRestore(){today=localToday(state.settings.timeZone);date=today;month=today.slice(0,7);tab='today';view='day';dirty=false;dialog.close();render();haptic('success');toast('Личный план восстановлен. Предыдущие данные сохранены в копии.')}
async function recoveryCopies(){
  const data=await api('backups');
  modal('Копии перед восстановлением','Сервер хранит последние пять состояний перед заменой данных.',data.backups.length?`<div class="history">${data.backups.map(c=>`<button class="history-item" data-action="copy-preview" data-id="${c.id}" data-revision="${state.revision}" data-at="${esc(c.at)}" data-count="${c.records}"><strong>${esc(new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:state.settings.timeZone}).format(new Date(c.at)))}</strong><small>${c.records} записей. Нажмите, чтобы проверить восстановление</small></button>`).join('')}</div>`:'<div class="empty"><h3>Сохранённых состояний пока нет</h3><p>Они появятся после первого восстановления из файла.</p></div>');
}
function copyPreview(id,revision,at,count){
  modal('Вернуть прежний план',new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:state.settings.timeZone}).format(new Date(at)),`<p class="help-copy">В выбранном состоянии ${count} записей. Оно заменит текущий личный план, заметки и настройки. Перед заменой текущее состояние тоже сохранится.</p><p class="error" id="restore-error" role="alert"></p><div class="actions"><button class="primary" data-action="copy-restore" data-id="${id}" data-revision="${revision}">Восстановить это состояние</button></div>`);
}
async function restoreCopy(id,revision){
  busy=true;const button=$('[data-action="copy-restore"]');button.disabled=true;
  try{await commit('restore-copy',{id,revision});afterRestore()}
  catch(e){$('#restore-error').textContent=e.message}
  finally{busy=false;button.disabled=false}
}
async function accessScreen(message){$('#navigation').hidden=true;main.innerHTML=`<section class="access"><img src="/icon.svg" alt="" width="86" height="86"><h1>Ваша смена.<br>Внутри Telegram.</h1><p>${esc(message||'Личный кабинет с расписанием, клиентами и заметками. Откройте его кнопкой «Моя смена» в боте.')}</p>${botUsername?`<a class="primary" href="https://t.me/${esc(botUsername)}">Открыть бота в Telegram</a>`:'<button class="primary" data-action="retry">Попробовать ещё раз</button>'}<a class="text-button" style="display:inline-block" href="/demo">Посмотреть демоверсию</a><p class="inline-hint">Личный план защищён входом через Telegram.<br>Демоверсия содержит только вымышленные данные.</p></section>`}
let swipeX=null,swipeY=0;
main.addEventListener('touchstart',e=>{const t=e.touches[0];swipeX=tab==='today'&&view==='day'&&!dialog.open&&e.touches.length===1&&t.clientX>28&&t.clientX<innerWidth-28?t.clientX:null;swipeY=t.clientY},{passive:true});
main.addEventListener('touchend',e=>{if(swipeX===null)return;const t=e.changedTouches[0],dx=t.clientX-swipeX,dy=t.clientY-swipeY;swipeX=null;if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*2){date=shift(date,dx<0?1:-1);haptic();go(render,dx<0?'next':'prev')}},{passive:true});
// Ссылки вида /?date=2026-11-14, ?record=<id>, ?client=<имя>, ?tab=stats открывают нужное место: так кнопки бота ведут в приложение.
function openLink(){
  try{
    const p=new URLSearchParams(location.search);if(![...p.keys()].length)return;
    const d=p.get('date'),t=p.get('tab'),c=p.get('client'),r=state.records.find(x=>x.id===p.get('record'));
    if(isDate(d)){date=d;month=d.slice(0,7)}
    if(['calendar','clients','stats'].includes(t))tab=t;
    if(r){date=r.date;month=date.slice(0,7);tab='today'}
    const known=c&&state.records.some(x=>x.type!=='block'&&x.name===c);if(known)tab='clients';
    render();
    if(r)editor(r.id);else if(known)clientCard(c);
    history.replaceState(null,'',location.pathname+location.hash);
  }catch{}
}
async function init(){theme();safeArea();$('#settings-button').innerHTML=icon('settings');if(tg?.initData)document.documentElement.classList.add('tg');try{tg?.ready();tg?.expand();/* свайп вниз закрывал бы приложение при прокрутке расписания */if(tg?.isVersionAtLeast?.('7.7'))tg.disableVerticalSwipes();mainBtn?.onClick(()=>{if(mainTarget&&!mainTarget.disabled){haptic();mainTarget.form.requestSubmit(mainTarget)}});tg?.onEvent('themeChanged',theme);tg?.onEvent('contentSafeAreaChanged',safeArea);tg?.onEvent('safeAreaChanged',safeArea);tg?.BackButton?.onClick(()=>{if(dialog.open)closeModal();else{tab='today';render()}})}catch{}
  if(demo){document.getElementById('mode').hidden=false;state=demoSeed();try{const saved=JSON.parse(localStorage.getItem(DEMO_KEY));if(saved&&Array.isArray(saved.records)&&saved.settings&&Array.isArray(saved.settings.services)&&saved.clientNotes&&Number.isInteger(saved.revision))state={...defaults(),...saved,dayOverrides:saved.dayOverrides||{}}}catch{}owner=true;today=localToday(state.settings.timeZone);date=today;month=today.slice(0,7);$('#mode').textContent='Демоверсия';render();openLink();return}
  try{const p=await api('public');botUsername=p.botUsername;if(tg?.initData)await api('session',{initData:tg.initData});await refresh();date=today;month=today.slice(0,7);render();openLink()}catch(e){accessScreen(e.status===403?e.message:e.status===401?undefined:'Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.')}
}
document.addEventListener('input',e=>{if(e.target.id==='client-search'){query=e.target.value;clientResults()}});
document.addEventListener('change',async e=>{if(e.target.id==='backup-file'){const file=e.target.files[0];e.target.value='';try{await previewImport(file)}catch(error){toast(error.message)}return;}if(e.target.id==='share-service'||e.target.id==='share-days'){$('#share-text').value=freeText(shareFrom,Number($('#share-days').value),Number($('#share-service').value));return}if(e.target.id==='theme-choice'){storePreference('smena-theme',e.target.value);theme()}if(e.target.name==='service'&&e.target.form?.id==='record-form'){const s=state.settings.services.find(s=>s.name===e.target.value);if(s){e.target.form.elements.duration.value=s.duration;e.target.form.elements.price.value=s.price}}});
document.addEventListener('submit',async e=>{if(!['record-form','settings-form','client-note-form','day-form','sync-form'].includes(e.target.id))return;if(e.target.id==='sync-form'){e.preventDefault();if(busy)return;busy=true;const f=e.target,button=f.querySelector('[type=submit]'),error=f.querySelector('.error');error.textContent='';button.disabled=true;button.textContent='Загружаем календарь…';try{await commit('sync-config',{url:String(new FormData(f).get('url')||'').trim()});dirty=false;settings();render();toast(syncInfo?.error?'Ссылка сохранена, но загрузка не удалась: '+syncInfo.error:'YCLIENTS подключён, записей: '+syncInfo?.count);haptic(syncInfo?.error?'error':'success')}catch(x){error.textContent=x.message;haptic('error')}finally{busy=false;button.disabled=false;button.textContent='Подключить YCLIENTS'}return}e.preventDefault();if(busy)return;busy=true;const f=e.target,button=f.querySelector('[type=submit]'),error=f.querySelector('.error');error.textContent='';button.disabled=true;try{if(f.id==='record-form')await submitRecord(f);else if(f.id==='settings-form')await submitSettings(f);else if(f.id==='day-form')await submitDay(f);else{await commit('client-note',{name:f.dataset.name,note:new FormData(f).get('note'),revision:Number(f.dataset.revision)});f.dataset.revision=String(state.revision);dirty=false;toast('Заметка сохранена')}}catch(e){error.textContent=e.name==='TimeoutError'||e.name==='TypeError'?'Нет связи с сервером. Изменения не подтверждены; попробуйте снова.':e.message;haptic('error')}finally{busy=false;button.disabled=false}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b||busy)return;const a=b.dataset.action,v=b.dataset.value;try{
  if(a==='tab'){tab=v;if(tab==='today'){date=today;view='day'}if(tab==='calendar')month=date.slice(0,7);haptic();go(()=>{render();window.scrollTo(0,0)})}
  else if(a==='date'){const dir=tab!=='today'?'':v>date?'next':v<date?'prev':'';date=v;view='day';tab='today';haptic();go(()=>{render();window.scrollTo(0,0)},dir)}
  else if(a==='week'){date=shift(date,Number(v));go(render,Number(v)>0?'next':'prev')}else if(a==='today'){date=today;render()}else if(a==='month'){const d=parse(month+'-01');d.setUTCMonth(d.getUTCMonth()+Number(v));month=iso(d).slice(0,7);render()}
  else if(a==='view'){view=v;render()}else if(a==='new')editor();else if(a==='block')editor(null,null,null,true);else if(a==='free')editor(null,v);else if(a==='edit')editor(b.dataset.id);else if(a==='client')clientCard(b.dataset.name);else if(a==='new-client')editor(null,null,b.dataset.name);
  else if(a==='day')daySettings();else if(a==='settings'){if(state)settings();else toast('Откройте личный кабинет или демоверсию.')}else if(a==='close')closeModal();
  else if(a==='cancel-ask')$('#cancel-confirm').innerHTML='<div class="confirm">Подтвердить отмену в личном плане?<br><button type="button" class="secondary danger" data-action="cancel-confirm">Да, отменить</button><button type="button" class="text-button" data-action="cancel-back">Оставить</button></div>';
  else if(a==='cancel-back')$('#cancel-confirm').innerHTML='';
  else if(a==='cancel-confirm'){const before=structuredClone(state.records.find(x=>x.id===editing));busy=true;try{await commit('cancel',{id:editing,revision:Number($('#record-form').dataset.revision)});dirty=false;dialog.close();render();toast('Время освобождено',before&&{label:'Вернуть',run:()=>undo(before)})}finally{busy=false}}
  else if(a==='add-service'){if($$('[data-service]').length>=20){toast('Можно добавить до 20 услуг.');return}$('#service-rows').insertAdjacentHTML('beforeend',serviceRow({name:'',duration:60,price:0},$$('[data-service]').length));dirty=true}
  else if(a==='remove-service'){if($$('[data-service]').length===1){toast('Оставьте хотя бы одну услугу.');return}b.closest('[data-service]').remove();dirty=true}
  else if(a==='export')download();
  else if(a==='export-csv'){const cell=x=>{const s=String(x??'');return /^[=+\-@\t\r]/.test(s)?`"'${s.replaceAll('"','""')}"`:`"${s.replaceAll('"','""')}"`};const rows=[['Дата','Время','Длительность, мин','Клиент','Услуга','Статус','Цена, ₽','Телефон','Источник','Заметка'],...state.records.filter(r=>r.type!=='block').sort((x,y)=>(x.date+x.time).localeCompare(y.date+y.time)).map(r=>[r.date,r.time,r.duration,r.name,r.service,labels[r.status],r.price||0,r.phone,r.source==='yclients'?'YCLIENTS':'Личный план',r.note])];const blob=new Blob(['﻿'+rows.map(r=>r.map(cell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='smena-zapisi-'+today+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Таблица записей подготовлена')}
  else if(a==='import-open')$('#backup-file').click();
  else if(a==='import-confirm')await finishImport();
  else if(a==='copies')await recoveryCopies();
  else if(a==='copy-preview')copyPreview(Number(b.dataset.id),Number(b.dataset.revision),b.dataset.at,Number(b.dataset.count));
  else if(a==='copy-restore')await restoreCopy(Number(b.dataset.id),Number(b.dataset.revision));
  else if(a==='day-reset')await resetDay();
  else if(a==='invite'){const invite=await api('invite',{});$('#access-result').innerHTML=`<p class="inline-hint">Одноразовое приглашение действует 24 часа. Передайте только подруге.</p><p class="invite-link" id="invite-url">${esc(invite.url)}</p><button class="text-button" data-action="copy-invite">Скопировать приглашение</button>`}
  else if(a==='copy-invite'){await navigator.clipboard.writeText($('#invite-url').textContent);toast('Приглашение скопировано')}
  else if(a==='revoke-ask')$('#access-result').innerHTML='<div class="confirm">Закрыть доступ подруге? Её сеансы завершатся, записи сохранятся.<br><button class="secondary danger" data-action="revoke">Закрыть доступ</button></div>';
  else if(a==='revoke'){await api('revoke',{});hasFriend=false;settings();toast('Доступ подруге закрыт')}
  else if(a==='reset-ask')$('#access-result').innerHTML='<div class="confirm">Удалить изменения демоверсии и восстановить примеры?<br><button class="secondary" data-action="reset">Восстановить</button></div>';
  else if(a==='reset'){state=demoSeed();storePreference(DEMO_KEY,JSON.stringify(state));today=localToday(state.settings.timeZone);date=today;tab='today';view='day';dirty=false;dialog.close();render();toast('Демоданные восстановлены')}
  else if(a==='refresh'||a==='sync-now'){if(demo){render();toast('План обновлён');return}busy=true;b.disabled=true;try{if(syncInfo?.mode)await commit('sync-now',{});else await refresh()}finally{busy=false;b.disabled=false}if(dialog.open&&$('#settings-form'))settings();render();toast(syncInfo?.mode?(syncInfo.error?'YCLIENTS: '+syncInfo.error:'Синхронизировано с YCLIENTS'):'План обновлён')}
  else if(a==='sync-off')$('#access-result').innerHTML='<div class="confirm">Отключить YCLIENTS? Загруженные записи YCLIENTS исчезнут из плана, ваши личные записи останутся.<br><button class="secondary danger" data-action="sync-off-confirm">Отключить</button></div>';
  else if(a==='sync-off-confirm'){await commit('sync-config',{url:null});settings();render();toast('YCLIENTS отключён')}
  else if(a==='quick-status'){const r=state.records.find(x=>x.id===b.dataset.id);if(!r)return;const before=structuredClone(r);busy=true;try{await commit('record',{record:{...r,status:v}})}finally{busy=false}dirty=false;if(dialog.open)dialog.close();render();haptic('success');toast(labels[v]+': '+r.name,{label:'Вернуть',run:()=>undo(before)})}
  else if(a==='repeat'){const r=state.records.find(x=>x.id===b.dataset.id);if(!r)return;dirty=false;editor(null,r.time,r.name,false,{date:shift(r.date,28),service:r.service,phone:r.phone})}else if(a==='retry')init();
  else if(a==='segment'){segment=v;haptic();clientResults()}
  else if(a==='period'){period=Number(v);haptic();render()}
  else if(a==='show-lost'){tab='clients';segment='lost';query='';go(()=>{render();window.scrollTo(0,0)})}
  else if(a==='share-free')shareFree();
  else if(a==='message-client'){const c=clientSummaries(state,today).find(x=>x.name===b.dataset.name);if(c)shareDialog('Сообщение клиенту',c.name,clientMessage(c),{phone:c.phone})}
  else if(a==='message-record'){const r=state.records.find(x=>x.id===b.dataset.id);if(r)shareDialog('Напоминание о визите',r.name,recordMessage(r),{phone:phoneOf(r)})}
  else if(a==='share-send')await sendText($('#share-text').value);
  else if(a==='share-copy')toast(await copyText($('#share-text').value)?'Текст скопирован':'Выделите текст и скопируйте его вручную');
  else if(a==='share-wa')openExternal('https://wa.me/'+v+'?text='+encodeURIComponent($('#share-text').value));
}catch(e){toast(e.message||'Не удалось выполнить действие. Попробуйте снова.')}});
async function undo(before){await commit('record',{record:before});render();haptic();toast('Запись возвращена')}
// Внутри Telegram внешние ссылки открывает сам Telegram: иначе они остаются во встроенном окне Mini App.
function openExternal(url){if(tg?.initData){try{if(url.startsWith('https://t.me/'))tg.openTelegramLink(url);else tg.openLink(url);return}catch{}}window.open(url,'_blank','noopener')}
document.addEventListener('click',e=>{const a=e.target.closest('a[data-ext]');if(!a||!tg?.initData)return;e.preventDefault();openExternal(a.href)});
window.addEventListener('offline',()=>toast('Нет соединения. Изменения личного плана потребуют связи с сервером.'));
setInterval(()=>{if(document.hidden||!state||dialog.open||busy)return;if(document.activeElement?.id==='client-search')return;if(demo){if(tab==='today')render();return}refresh().then(()=>{if(!dialog.open&&!busy&&document.activeElement?.id!=='client-search')render()}).catch(()=>{})},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state&&!demo&&!dialog.open&&!busy)refresh().then(render).catch(()=>{})});
await init();
