import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../lib/core.mjs';
import {collectNotifications} from '../lib/reminders.mjs';
import {dayView,freeView,weekView,nextView,findView,statsView,statusButtons,parseAdd,parseDay} from '../lib/views.mjs';
import {clientSummaries,isLost,isNew,periodStats,slotStarts,freeGaps,phoneDigits} from '../shared.mjs';

const today='2026-11-10',url='https://smena.test';
const visit=(id,date,time,name,extra={})=>({id,date,time,name,duration:60,service:'Мужская стрижка',status:'confirmed',type:'visit',note:'',phone:'',price:1500,...extra});
function sample(){
  const s=initialState();
  s.records=[
    visit('a','2026-11-10','10:00','Иван <Первый>',{status:'done'}),
    visit('b','2026-11-10','12:00','Олег',{phone:'8 (999) 123-45-67',note:'Оставить длину сверху'}),
    visit('y','2026-11-10','15:00','Марк',{source:'yclients',externalId:'e1',price:0}),
    visit('c','2026-11-10','16:30','Пётр',{status:'noshow'}),
    {...visit('k','2026-11-10','13:00','Время закрыто'),type:'block',service:'Перерыв',note:'Обед',duration:30,price:0},
    visit('d','2026-11-12','11:00','Иван <Первый>'),
    visit('o1','2026-08-01','10:00','Олег',{status:'done'}),visit('o2','2026-08-29','10:00','Олег',{status:'done'}),
    visit('l1','2026-07-01','10:00','Давний',{status:'done',price:2000}),visit('l2','2026-08-01','12:00','Давний',{status:'done',price:2000}),
  ];
  s.clientNotes={'Олег':'Любит покороче'};
  return s;
}
const data=view=>view.keyboard.inline_keyboard.flat().map(b=>b.callback_data||b.web_app.url);

test('Day view: escaped names, statuses, block time, navigation and a deep link into the app',()=>{
  const view=dayView(sample(),today,today,url);
  assert.match(view.text,/^<b>Вторник, 10 ноября<\/b> — сегодня\n10:00–19:00, 3 визита, свободно 5 ч 30 мин/);
  assert.match(view.text,/<b>10:00<\/b>–11:00  Иван &lt;Первый&gt; — завершён\nМужская стрижка, 1 500 ₽/);
  assert.match(view.text,/<b>13:00<\/b>–13:30  Обед/);assert.match(view.text,/Марк \(YCLIENTS\)/);
  assert.ok(!view.text.includes('Пётр')); // неявка в план не попадает
  assert.deepEqual(data(view),['d:2026-11-09','d:2026-11-11','f:2026-11-10','d:2026-11-10','https://smena.test/?date=2026-11-10']);
  assert.ok(data(dayView(sample(),'2026-11-12',today,url)).includes('d:today')); // с другого дня есть возврат к сегодня
});

test('Free windows, week and stats views count from the same data',()=>{
  const s=sample();
  assert.match(freeView(s,today,today,'11:05',url).text,/11:15–12:00  \(45 мин\)\n13:30–15:00  \(1 ч 30 мин\)\n16:00–19:00  \(3 ч\)/);
  assert.match(freeView(s,today,today,'18:50',url).text,/Сегодня свободных окон больше нет\./);
  s.dayOverrides['2026-11-11']={closed:true,start:'10:00',end:'19:00'};
  assert.match(freeView(s,'2026-11-11',today,'11:05',url).text,/Выходной по графику\./);
  const week=weekView(s,today,url);
  assert.match(week.text,/<b>вт 10<\/b> — 3 визита, 10:00–16:00\n<b>ср 11<\/b> — выходной\n<b>чт 12<\/b> — 1 визит, 11:00–12:00\n<b>пт 13<\/b> — свободно/);
  assert.match(week.text,/Всего 4 визита, ожидается 3 000 ₽\./);assert.equal(data(week).filter(d=>d.startsWith('d:')).length,7);
  const stats=statsView(s,today,url).text;
  assert.match(stats,/Завершено: 1 визит \(неделей раньше — 0\)\nВыручка: 1 500 ₽, средний чек 1 500 ₽/);
  assert.match(stats,/Неявок: 1, отмен: 0/);assert.match(stats,/Давно не были: 1 клиент\n/);
});

test('Next visit shows what to remember about the client; YCLIENTS records get no status buttons',()=>{
  const s=sample(),next=nextView(s,{date:today,time:'11:40'},url);
  assert.match(next.text,/^<b>Ближайший визит — через 20 мин<\/b>\n12:00–13:00  Олег\n/);
  assert.match(next.text,/Тел\. 8 \(999\) 123-45-67\nЗаметка к визиту: Оставить длину сверху\nО клиенте: Любит покороче\n\nБыл 2 раза, последний — 73 дн\. назад\./);
  assert.deepEqual(data(next),['s:b:arrived','s:b:noshow','d:2026-11-10','https://smena.test/?record=b']);
  const yc=nextView(s,{date:today,time:'14:00'},url);
  assert.match(yc.text,/сегодня в 15:00<\/b>\n15:00–16:00  Марк \(YCLIENTS\)/);assert.ok(!data(yc).some(d=>d.startsWith('s:')));
  assert.match(nextView(s,{date:today,time:'12:30'},url).text,/^Сейчас в кресле: <b>Олег<\/b>, до 13:00\./);
  assert.match(nextView(s,{date:'2026-12-01',time:'10:00'},url).text,/Впереди записей нет\./);
  assert.deepEqual(statusButtons({...s.records[1],id:'x'.repeat(80)}),[]); // слишком длинный id не помещается в callback_data
  const reminder=collectNotifications(s,{date:today,time:'11:40'},url).find(i=>i.key.startsWith('visit:b:'));
  assert.match(reminder.text,/^<b>Через 20 мин: Олег<\/b>/);assert.equal(reminder.keyboard.inline_keyboard[0][0].callback_data,'s:b:arrived');
});

test('Client search by name or phone, lost and new clients, period stats',()=>{
  const s=sample(),byPhone=findView(s,'999123',today,url);
  assert.equal(byPhone.count,1);assert.match(byPhone.text,/^<b>Олег<\/b>\nПридёт сегодня в 12:00/);
  assert.match(findView(s,'давн',today,url).text,/<b>Давний<\/b> — давно не был/);
  assert.equal(findView(s,'нет такого',today,url).count,0);assert.equal(findView(s,'и',today,url).count,0);
  const list=clientSummaries(s,today),by=name=>list.find(c=>c.name===name);
  assert.deepEqual([by('Олег').visits,by('Олег').interval,by('Олег').daysSince,by('Олег').spent,by('Олег').next.id],[2,28,73,3000,'b']);
  assert.equal(isLost(by('Олег')),false);assert.equal(isLost(by('Давний')),true); // у Олега есть будущая запись
  assert.deepEqual([by('Пётр').visits,by('Пётр').noshow,isLost(by('Пётр')),isNew(by('Пётр'),today)],[0,1,false,true]);
  assert.equal(by('Иван <Первый>').last.id,'a');assert.equal(by('Иван <Первый>').next.id,'d');
  const p=periodStats(s,'2026-11-04',today);
  assert.deepEqual([p.planned,p.done,p.noshow,p.revenue,p.expected,p.avgCheck,p.noshowRate,p.clients,p.newClients],[3,1,1,1500,1500,1500,50,3,2]);
  assert.equal(p.load,Math.round(180/(7*540)*100));assert.equal(p.byDay.length,7);assert.deepEqual(p.byDay.at(-1),{date:today,count:3,revenue:1500});
  assert.deepEqual(p.services[0],{name:'Мужская стрижка',count:3,revenue:1500});
});

test('Slots for sharing, phone normalisation and /add parsing',()=>{
  const s=sample();
  assert.deepEqual(freeGaps(s,today),[[660,720],[810,900],[960,1140]]);
  assert.deepEqual(slotStarts(s,today,60,0),['11:00','13:30','14:00','16:00','16:30','17:00','17:30','18:00']);
  assert.deepEqual(slotStarts(s,today,60,17*60+10),['17:10','17:30','18:00']);
  assert.deepEqual([phoneDigits('8 (999) 123-45-67'),phoneDigits('+7 999 123 45 67'),phoneDigits('9991234567'),phoneDigits('12345')],['79991234567','79991234567','79991234567','']);
  assert.deepEqual(parseAdd('завтра 15:30 Иван Петров',today),{date:'2026-11-11',time:'15:30',name:'Иван Петров',phone:''});
  assert.deepEqual(parseAdd('9:05 Олег +7 999 123-45-67',today),{date:today,time:'09:05',name:'Олег',phone:'+7 999 123-45-67'});
  assert.deepEqual(parseAdd('15.30 Иван',today),{date:today,time:'15:30',name:'Иван',phone:''}); // время через точку — не дата
  assert.equal(parseAdd('14.11 12:00 Олег',today).date,'2026-11-14');assert.equal(parseAdd('01.02 12:00 Олег',today).date,'2027-02-01');
  for(const bad of ['','Иван','25:00 Иван','12:00','31.02 12:00 Иван','вчера 12:00 Иван'])assert.equal(parseAdd(bad,today),null);
  assert.deepEqual([parseDay('',today),parseDay('Завтра',today),parseDay('14.11.2026',today),parseDay('чушь',today)],[today,'2026-11-11','2026-11-14',null]);
});
