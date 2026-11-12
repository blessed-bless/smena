// Сообщения бота: чистые функции «состояние -> {text, keyboard}». Сети и базы здесь нет, поэтому
// каждый экран чата проверяется обычным тестом. Текст — HTML Telegram, всё пользовательское экранируется.
import {workday,freeGaps,hhmm,mins,shiftDate,isDate,isActive,isVisit,isLost,clientSummaries,periodStats,phoneDigits,monthMoney,dueClients} from '../shared.mjs';

export const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmt=(date,options)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',...options}).format(new Date(date+'T12:00:00Z'));
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const pad=n=>String(n).padStart(2,'0');
export const dayTitle=date=>fmt(date,{weekday:'long',day:'numeric',month:'long'});
const shortDay=date=>fmt(date,{weekday:'short'})+' '+Number(date.slice(8));
const dayMonth=date=>fmt(date,{day:'numeric',month:'long'});
export const plural=(n,one,few,many)=>n%100>=11&&n%100<=14?many:n%10===1?one:n%10>=2&&n%10<=4?few:many;
const visitsWord=n=>n+' '+plural(n,'визит','визита','визитов');
export const dur=n=>n>=60?Math.floor(n/60)+' ч'+(n%60?' '+n%60+' мин':''):n+' мин';
export const money=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n).replace(/[  ]/g,' ')+' ₽';
const STATUS={waiting:'ждёт ответа',arrived:'пришёл',done:'завершён',cancelled:'отменён',noshow:'не пришёл'};
const relative=(date,today)=>date===today?'сегодня':date===shiftDate(today,1)?'завтра':date===shiftDate(today,-1)?'вчера':'';
const byMoment=(a,b)=>(a.date+a.time).localeCompare(b.date+b.time);
const endOf=r=>hhmm(mins(r.time)+r.duration);

export const footer=state=>state.records.some(r=>r.source==='yclients')?'Личный план и записи YCLIENTS.':'Личный план. YCLIENTS не подключён.';
// Кнопка, открывающая Mini App сразу на нужном месте: дата, запись, клиент или вкладка.
const open=(url,text,query={})=>{const q=new URLSearchParams(query).toString();return {text,web_app:{url:url.replace(/\/+$/,'')+'/'+(q?'?'+q:'')}}};
const button=(text,data)=>({text,callback_data:data});
const fits=data=>Buffer.byteLength(data)<=64; // предел Telegram для callback_data

export function launchKeyboard(url){
  return {inline_keyboard:[
    [open(url,'Открыть мою смену')],
    [button('Сегодня','d:today'),button('Завтра','d:tomorrow'),button('Окна','f:today')],
    [button('Неделя','w'),button('Ближайший','n'),button('Итоги','st')]
  ]};
}

// Кнопки статуса — только для личных записей: записи YCLIENTS «Смена» не меняет.
export function statusButtons(record){
  if(record.source==='yclients'||!isVisit(record))return [];
  const next={confirmed:['arrived','noshow'],waiting:['arrived','noshow'],arrived:['done','noshow']}[record.status]||[];
  const labels={arrived:'Пришёл',done:'Завершён',noshow:'Не пришёл'};
  return next.map(s=>button(labels[s],`s:${record.id}:${s}`)).filter(b=>fits(b.callback_data));
}

function visitLines(r){
  if(!isVisit(r))return `<b>${r.time}</b>–${endOf(r)}  ${esc(r.note||'Время закрыто')}\n\n`;
  const mark=STATUS[r.status]?' — '+STATUS[r.status]:'';
  return `<b>${r.time}</b>–${endOf(r)}  ${esc(r.name)}${mark}${r.source==='yclients'?' (YCLIENTS)':''}\n${esc(r.service)}${r.price?', '+money(r.price):''}\n\n`;
}

export function dayView(state,date,today,url=''){
  const hours=workday(state,date),rows=state.records.filter(r=>r.date===date&&isActive(r)).sort(byMoment);
  const visits=rows.filter(isVisit),free=(freeGaps(state,date)||[]).reduce((n,[s,e])=>n+e-s,0),rel=today?relative(date,today):'';
  let text=`<b>${cap(dayTitle(date))}</b>${rel?' — '+rel:''}\n`;
  text+=hours.closed?(rows.length?'Выходной по графику, но записи есть.':'Выходной по графику.')
    :`${hours.start}–${hours.end}, ${visits.length?visitsWord(visits.length):'записей нет'}${free?', свободно '+dur(free):''}`;
  text+='\n\n';
  let shown=0;
  for(const r of rows){
    const line=visitLines(r);
    if(text.length+line.length>3400)break;
    text+=line;shown++;
  }
  if(shown<rows.length)text+=`Ещё ${rows.length-shown} — откройте приложение.\n\n`;
  // Сегодня есть окна — подсказываем, кому написать: у кого подошёл обычный срок стрижки.
  const due=date===today&&free&&!hours.closed?dueClients(state,today):[];
  if(due.length)text+=`<b>Позвать в окна:</b> ${due.map(c=>`${esc(c.name)} (${c.daysSince} ${plural(c.daysSince,'день','дня','дней')})`).join(', ')}\n\n`;
  text+=footer(state);
  const keyboard={inline_keyboard:[
    [button('« '+shortDay(shiftDate(date,-1)),'d:'+shiftDate(date,-1)),...(date===today?[]:[button('Сегодня','d:today')]),button(shortDay(shiftDate(date,1))+' »','d:'+shiftDate(date,1))],
    [button('Окна','f:'+date),button('Обновить','d:'+date)],
    ...(url?[[open(url,'Открыть день в приложении',{date})]]:[])
  ]};
  return {text,keyboard};
}

export function freeView(state,date,today,nowTime,url=''){
  const from=date===today?Math.ceil(mins(nowTime)/15)*15:0,gaps=date<today?[]:freeGaps(state,date,from),rel=relative(date,today);
  const body=gaps===null?(date===today?'Сегодня выходной по графику.':'Выходной по графику.')
    :gaps.length?gaps.map(([s,e])=>`${hhmm(s)}–${hhmm(e)}  (${dur(e-s)})`).join('\n')
    :date===today?'Сегодня свободных окон больше нет.':'Свободных окон нет.';
  const text=`<b>Свободные окна: ${dayTitle(date)}</b>${rel?' — '+rel:''}\n\n${body}\n\n${footer(state)}`;
  const keyboard={inline_keyboard:[
    [button('« '+shortDay(shiftDate(date,-1)),'f:'+shiftDate(date,-1)),button(shortDay(shiftDate(date,1))+' »','f:'+shiftDate(date,1))],
    [button('План дня','d:'+date)],
    ...(url&&gaps?.length?[[open(url,'Записать клиента',{date})]]:[])
  ]};
  return {text,keyboard};
}

export function weekView(state,today,url=''){
  const days=Array.from({length:7},(_,i)=>shiftDate(today,i)),end=days[6];
  let text=`<b>Неделя: ${dayMonth(today)} — ${dayMonth(end)}</b>\n\n`;
  for(const d of days){
    const rows=state.records.filter(r=>r.date===d&&isActive(r)&&isVisit(r)).sort(byMoment);
    const info=rows.length?`${visitsWord(rows.length)}, ${rows[0].time}–${endOf(rows.at(-1))}`:workday(state,d).closed?'выходной':'свободно';
    text+=`<b>${shortDay(d)}</b> — ${info}\n`;
  }
  const stats=periodStats(state,today,end);
  text+=`\nВсего ${visitsWord(stats.planned)}${stats.expected?', ожидается '+money(stats.expected):''}.\n${footer(state)}`;
  const keys=days.map(d=>button(shortDay(d),'d:'+d));
  return {text,keyboard:{inline_keyboard:[keys.slice(0,4),keys.slice(4),...(url?[[open(url,'Открыть календарь',{tab:'calendar'})]]:[])]}};
}

function clientLine(state,summary){
  if(!summary)return '';
  const parts=[];
  if(summary.visits)parts.push(`был ${summary.visits} ${plural(summary.visits,'раз','раза','раз')}`+(summary.daysSince?`, последний — ${summary.daysSince} дн. назад`:''));
  else parts.push('первый визит');
  if(summary.noshow)parts.push(`не пришёл ${summary.noshow} ${plural(summary.noshow,'раз','раза','раз')}`);
  return cap(parts.join('; '))+'.';
}
const noteOf=(state,name)=>Object.hasOwn(state.clientNotes||{},name)?state.clientNotes[name]:'';

// Ближайший визит: кто придёт следующим, сколько осталось и что о нём стоит помнить.
export function nextView(state,now,url=''){
  const today=now.date,visits=state.records.filter(r=>isVisit(r)&&isActive(r)&&r.status!=='done').sort(byMoment);
  const current=visits.find(r=>r.date===today&&r.time<=now.time&&now.time<endOf(r));
  const next=visits.find(r=>r.date+r.time>today+now.time);
  let text=current?`Сейчас в кресле: <b>${esc(current.name)}</b>, до ${endOf(current)}.\n\n`:'';
  if(!next)return {text:text+'Впереди записей нет.\n\n'+footer(state),keyboard:{inline_keyboard:[[button('Окна','f:today'),button('Неделя','w')],...(url?[[open(url,'Записать клиента')]]:[])]}};
  const left=mins(next.time)-mins(now.time);
  const when=next.date===today?(left<60?`через ${left} мин`:`сегодня в ${next.time}`):`${relative(next.date,today)||dayTitle(next.date)} в ${next.time}`;
  const summary=clientSummaries(state,today).find(c=>c.name===next.name),clientNote=noteOf(state,next.name);
  text+=`<b>Ближайший визит — ${when}</b>\n${next.time}–${endOf(next)}  ${esc(next.name)}${next.source==='yclients'?' (YCLIENTS)':''}\n${esc(next.service)}${next.price?', '+money(next.price):''}\n`;
  if(next.phone)text+=`Тел. ${esc(next.phone)}\n`;
  if(next.note)text+=`Заметка к визиту: ${esc(next.note.slice(0,300))}\n`;
  if(clientNote)text+=`О клиенте: ${esc(clientNote.slice(0,300))}\n`;
  text+=`\n${clientLine(state,summary)}`;
  const status=next.date===today?statusButtons(next):[];
  return {text,keyboard:{inline_keyboard:[...(status.length?[status]:[]),[button('План дня','d:'+next.date)],...(url?[[open(url,'Открыть запись',{record:next.id})]]:[])]}};
}

export function findView(state,query,today,url=''){
  const q=query.trim().toLocaleLowerCase('ru'),digits=q.replace(/\D/g,'');
  if(q.length<2)return {count:0,text:'Напишите имя или телефон клиента, например: <code>/find Иван</code>',keyboard:{inline_keyboard:[]}};
  const found=clientSummaries(state,today).filter(c=>c.name.toLocaleLowerCase('ru').includes(q)||digits.length>=4&&phoneDigits(c.phone).includes(digits))
    .sort((a,b)=>(a.next?0:1)-(b.next?0:1)||(a.daysSince??1e9)-(b.daysSince??1e9)||a.name.localeCompare(b.name,'ru'));
  if(!found.length)return {count:0,text:`Клиент «${esc(query.trim().slice(0,60))}» не найден.`,keyboard:{inline_keyboard:url?[[open(url,'Все клиенты',{tab:'clients'})]]:[]}};
  let text='';
  for(const c of found.slice(0,5)){
    text+=`<b>${esc(c.name)}</b>${isLost(c)?' — давно не был':''}\n`;
    if(c.next)text+=`Придёт ${relative(c.next.date,today)||dayMonth(c.next.date)} в ${c.next.time}, ${esc(c.next.service)}\n`;
    text+=clientLine(state,c)+'\n';
    if(c.phone)text+=`Тел. ${esc(c.phone)}\n`;
    const note=noteOf(state,c.name);if(note)text+=`О клиенте: ${esc(note.slice(0,200))}\n`;
    text+='\n';
  }
  if(found.length>5)text+=`И ещё ${found.length-5} — уточните запрос или откройте приложение.`;
  const rows=url?found.slice(0,5).map(c=>[open(url,c.name.slice(0,40),{client:c.name})]):[];
  return {count:found.length,text:text.trim(),keyboard:{inline_keyboard:rows}};
}

export function statsView(state,today,url=''){
  const from=shiftDate(today,-6),cur=periodStats(state,from,today),prev=periodStats(state,shiftDate(today,-13),shiftDate(today,-7)),ahead=periodStats(state,shiftDate(today,1),shiftDate(today,7));
  let text=`<b>Итоги: ${dayMonth(from)} — ${dayMonth(today)}</b>\n\n`;
  text+=`Завершено: ${visitsWord(cur.done)} (неделей раньше — ${prev.done})\n`;
  if(cur.revenue||prev.revenue)text+=`Выручка: ${money(cur.revenue)}${cur.avgCheck?', средний чек '+money(cur.avgCheck):''}\n`;
  text+=`Загрузка: ${cur.load}%\nНеявок: ${cur.noshow}, отмен: ${cur.cancelled}\n`;
  if(cur.newClients)text+=`Новых клиентов: ${cur.newClients}\n`;
  if(cur.services.length)text+=`Чаще всего: ${esc(cur.services[0].name)} (${cur.services[0].count})\n`;
  const lost=clientSummaries(state,today).filter(isLost).length;
  if(lost)text+=`Давно не были: ${lost} ${plural(lost,'клиент','клиента','клиентов')}\n`;
  text+=`\nВпереди 7 дней: ${visitsWord(ahead.planned)}${ahead.expected?', ожидается '+money(ahead.expected):''}.`;
  const m=monthMoney(state,today);
  if(m.forecast||m.goal)text+=`\n\n<b>Мои деньги за месяц</b>${m.share<100?' (доля '+m.share+'%)':''}\nЗаработано: ${money(m.earned)}, ещё в записях: ${money(m.booked)}`+(m.goal?`\nЦель ${money(m.goal)}: ${m.left?'осталось '+money(m.left)+(m.visitsToGoal?' — примерно '+visitsWord(m.visitsToGoal):''):'уже набрана с учётом записей'}`:'');
  return {text,keyboard:{inline_keyboard:[[button('Неделя','w'),button('Ближайший','n')],...(url?[[open(url,'Открыть обзор',{tab:'stats'})]]:[])]}};
}

export function reminderView(state,record,left,url=''){
  const clientNote=noteOf(state,record.name);
  let text=`<b>Через ${left} мин: ${esc(record.name)}</b>\n${record.time}–${endOf(record)}, ${esc(record.service)}\n`;
  if(record.phone)text+=`Тел. ${esc(record.phone)}\n`;
  if(record.note)text+=`Заметка к визиту: ${esc(record.note.slice(0,300))}\n`;
  if(clientNote)text+=`О клиенте: ${esc(clientNote.slice(0,300))}\n`;
  if(record.source==='yclients')text+='\nЗапись из YCLIENTS.';
  const status=statusButtons(record);
  return {text:text.trim(),keyboard:{inline_keyboard:[...(status.length?[status]:[]),...(url?[[open(url,'Открыть запись',{record:record.id})]]:[])]}};
}

// Сообщение после отметки статуса из чата: что отмечено и что можно сделать дальше.
export function statusView(record,url=''){
  const status=statusButtons(record);
  return {
    text:`<b>${esc(record.name)}</b> — ${STATUS[record.status]||'запись подтверждена'}\n${record.time}–${endOf(record)}, ${esc(record.service)}`,
    keyboard:{inline_keyboard:[...(status.length?[status]:[]),[button('План дня','d:'+record.date)],...(url?[[open(url,'Открыть запись',{record:record.id})]]:[])]}
  };
}

// День словами или числом: «завтра», «14.11», «14.11.2026», 2026-11-14. Пустая строка — сегодня; null — не разобрать.
// Дата без года, которая уже прошла, относится к следующему году.
export function parseDay(token,today){
  const t=String(token||'').toLocaleLowerCase('ru');
  const word={'':0,today:0,сегодня:0,tomorrow:1,завтра:1,послезавтра:2}[t];
  if(word!==undefined)return shiftDate(today,word);
  if(isDate(t))return t;
  const m=/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(t);
  if(!m)return null;
  let date=`${m[3]||today.slice(0,4)}-${pad(m[2])}-${pad(m[1])}`;
  if(!m[3]&&date<today)date=`${Number(today.slice(0,4))+1}${date.slice(4)}`;
  return isDate(date)?date:null;
}

// /add [сегодня|завтра|послезавтра|ДД.ММ[.ГГГГ]] ЧЧ:ММ Имя [телефон]
export function parseAdd(args,today){
  const tokens=String(args||'').trim().split(/\s+/).filter(Boolean),time=/^(\d{1,2})[:.](\d{2})$/;
  const first=tokens[0]||'',dotted=/^\d{1,2}\.\d{1,2}(\.\d{4})?$/.test(first);
  if(!first)return null;
  let date=today;
  // «15.30 Иван» — это время, а не дата: датой считаем только то, за чем следует время.
  if(dotted&&time.test(tokens[1]||'')||!time.test(first)){
    date=parseDay(first,today);
    if(!date)return null;
    tokens.shift();
  }
  const t=time.exec(tokens.shift()||'');
  if(!t||Number(t[1])>23||Number(t[2])>59)return null;
  let name=tokens.join(' '),phone='';
  const tail=/\s*((?:\+7|8)[\d\s()-]{9,16})$/.exec(name);
  if(tail&&phoneDigits(tail[1])){phone=tail[1].trim();name=name.slice(0,tail.index)}
  name=name.trim();
  if(!name||name.length>80)return null;
  return {date,time:pad(t[1])+':'+t[2],name,phone};
}
export const ADD_HELP='Запись из чата:\n<code>/add завтра 15:30 Иван Петров</code>\n<code>/add 14.11 12:00 Олег +7 999 123-45-67</code>\n\nДень можно не писать — тогда запись на сегодня. Услугу выберете кнопкой.';

export function addPrompt(draft,services,today){
  const rel=relative(draft.date,today);
  return {
    text:`Новая запись: <b>${dayTitle(draft.date)}${rel?' ('+rel+')':''}, ${draft.time}</b>\n${esc(draft.name)}${draft.phone?', '+esc(draft.phone):''}\n\nВыберите услугу:`,
    keyboard:{inline_keyboard:[...services.slice(0,12).map((s,i)=>[button(`${s.name.slice(0,36)}, ${dur(s.duration)}`,`a:${draft.id}:${i}`)]),[button('Не записывать',`a:${draft.id}:x`)]]}
  };
}
export function addedView(record,url=''){
  return {
    text:`<b>Записано</b>\n${cap(dayTitle(record.date))}, ${record.time}–${endOf(record)}\n${esc(record.name)}, ${esc(record.service)}${record.price?', '+money(record.price):''}`,
    keyboard:{inline_keyboard:[[button('План дня','d:'+record.date)],...(url?[[open(url,'Открыть запись',{record:record.id})]]:[])]}
  };
}

export const HELP=`<b>Смена</b> — рабочий день барбера в Telegram.

/today, /tomorrow — план дня, дальше листайте кнопками
/week — неделя по дням
/free — свободные окна
/next — ближайший клиент и заметки о нём
/add — записать клиента, не открывая приложение
/find — найти клиента по имени или телефону
/stats — итоги недели
/invite — пригласить помощника (для хозяина кабинета)

<b>Онлайн-запись.</b> Включите её в настройках приложения и поставьте ссылку в профиль соцсетей: клиенты сами выбирают свободное время, а вам приходит сообщение о каждой записи и отмене. Клиенту бот сам напомнит о визите за сутки.

Имя клиента можно просто написать в чат — бот найдёт его карточку. Настройки, услуги, история и резервные копии — в приложении.`;

// ——— Онлайн-запись: сообщения клиенту и мастеру ———
// Страница записи открывается кнопкой web_app; d и t подсвечивают предложенное окно.
export const bookUrl=(url,slug,extra={})=>url.replace(/\/+$/,'')+'/book?'+new URLSearchParams({c:slug,...extra});
const when=(r,today)=>{const rel=today?relative(r.date,today):'';return (rel?rel+', ':'')+dayTitle(r.date)+', '+r.time};
const clientCancel=(cabinet,r)=>{const data=`bc:${cabinet}:${r.id}`;return fits(data)?[[button('Отменить запись',data)]]:[]};

export function bookingStartView(title,note,url,slug){
  let text=`<b>Запись: ${esc(title)}</b>\nВыберите услугу и свободное время — запись придёт мастеру сразу.`;
  if(note)text+=`\n\n${esc(note)}`;
  return {text,keyboard:{inline_keyboard:[[{text:'Выбрать время',web_app:{url:bookUrl(url,slug)}}]]}};
}
export function bookedMasterView(r,today,url){
  let text=`<b>Новая онлайн-запись</b>\n${esc(r.name)}${r.phone?', '+esc(r.phone):''}\n${cap(when(r,today))}\n${esc(r.service)}, ${dur(r.duration)}${r.price?', '+money(r.price):''}`;
  if(r.clientTg)text+='\n\nКлиент записался через Telegram: напоминание за сутки бот пришлёт ему сам.';
  const cancel=button('Отменить запись','x:'+r.id);
  return {text,keyboard:{inline_keyboard:[...(fits(cancel.callback_data)?[[cancel]]:[]),...(url?[[open(url,'Открыть день',{date:r.date})]]:[])]}};
}
export function bookedClientView(r,title,note,cabinet,today){
  let text=`<b>Вы записаны</b>\n${cap(when(r,today))}\n${esc(r.service)}, ${dur(r.duration)}${r.price?', '+money(r.price):''}\nМастер: ${esc(title)}`;
  if(note)text+=`\n\n${esc(note)}`;
  text+='\n\nНапомним за сутки. Планы поменялись — отмените запись кнопкой ниже, чтобы время досталось другому.';
  return {text,keyboard:{inline_keyboard:clientCancel(cabinet,r)}};
}
export function clientReminderView(r,title,note,cabinet,today){
  let text=`<b>Напоминание о записи</b>\n${cap(when(r,today))}\n${esc(r.service)}\nМастер: ${esc(title)}`;
  if(note)text+=`\n\n${esc(note)}`;
  return {text,keyboard:{inline_keyboard:clientCancel(cabinet,r)}};
}
// Мастеру при отмене: кто отменил и кого из листа ожидания можно позвать на освободившееся время.
export function cancelledMasterView(r,by,waiting,today,url){
  let text=by==='client'?`<b>Клиент отменил запись</b>\n${esc(r.name)}, ${when(r,today)}, ${esc(r.service)}`:`<b>Освободилось ${when(r,today)}</b>`;
  const rows=[];
  if(waiting.length){
    text+='\n\nВ листе ожидания:\n'+waiting.map(w=>`• ${esc(w.name)}${w.phone?', '+esc(w.phone):''}${w.service?' — '+esc(w.service):''}${w.note?' ('+esc(w.note.slice(0,80))+')':''}`).join('\n');
    for(const w of waiting)if(w.clientTg){const b=button('Предложить: '+w.name.split(/\s+/)[0],`wo:${w.id}:${r.date}:${r.time}`);if(fits(b.callback_data))rows.push([b])}
    if(rows.length)text+='\n\nКнопка отправит клиенту предложение записаться на это время.';
  }
  return {text,keyboard:{inline_keyboard:[...rows,...(url?[[open(url,'Открыть день',{date:r.date})]]:[])]}};
}
export function cancelledClientView(r,title,url,slug,today){
  return {text:`<b>Мастер отменил вашу запись</b>\n${cap(when(r,today))}, ${esc(r.service)}\nМастер: ${esc(title)}\n\nВыберите другое время — кнопка ниже.`,keyboard:{inline_keyboard:slug?[[{text:'Выбрать другое время',web_app:{url:bookUrl(url,slug)}}]]:[]}};
}
export function movedClientView(r,title,cabinet,today){
  return {text:`<b>Мастер перенёс вашу запись</b>\nТеперь: ${when(r,today)}\n${esc(r.service)}\nМастер: ${esc(title)}\n\nНе подходит — отмените запись и выберите другое время.`,keyboard:{inline_keyboard:clientCancel(cabinet,r)}};
}
export function waitingMasterView(w,url){
  return {text:`<b>Новый клиент в листе ожидания</b>\n${esc(w.name)}${w.phone?', '+esc(w.phone):''}${w.service?'\n'+esc(w.service):''}${w.note?'\nПожелание: '+esc(w.note):''}\n\nКогда освободится время, бот подскажет позвать его.`,keyboard:{inline_keyboard:url?[[open(url,'Лист ожидания',{tab:'clients'})]]:[]}};
}
export function offerClientView(date,time,title,url,slug,today){
  return {text:`<b>Освободилось время</b>\n${cap(when({date,time},today))}\nМастер: ${esc(title)}\n\nХотите записаться? Окно могут занять — лучше не откладывать.`,keyboard:{inline_keyboard:[[{text:'Записаться',web_app:{url:bookUrl(url,slug,{d:date,t:time})}}]]}};
}
