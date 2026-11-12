import test from 'node:test';
import assert from 'node:assert/strict';
import {monthMoney,dueClients} from '../shared.mjs';
import {initialState,validateSettings} from '../lib/core.mjs';
import {statsView,dayView} from '../lib/views.mjs';

const visit=(id,name,date,status,price=2000)=>({id,name,date,time:'12:00',duration:60,status,price,service:'Мужская стрижка',type:'visit',note:'',phone:''});

test('Money: month earnings use the barber share, booked visits count only ahead, goal shows what is left',()=>{
  const s=initialState();s.settings.share=40;s.settings.goal=5000;
  s.records=[visit('a','Анна','2026-11-03','done',3000),visit('b','Борис','2026-11-10','done',2000),visit('c','Вера','2026-11-20','confirmed',2500),
    visit('d','Глеб','2026-11-05','noshow',9000),visit('e','Дина','2026-10-31','done',9000),visit('f','Ева','2026-12-01','confirmed',9000),visit('g','Жора','2026-11-08','confirmed',9000)];
  const m=monthMoney(s,'2026-11-12');
  assert.equal(m.from,'2026-11-01');assert.equal(m.end,'2026-11-30');assert.equal(m.daysLeft,19);
  assert.equal(m.earned,2000);assert.equal(m.booked,1000);assert.equal(m.forecast,3000); // прошлая неотмеченная запись не считается ни заработком, ни планом
  assert.equal(m.left,2000);assert.equal(m.avg,1000);assert.equal(m.visitsToGoal,2);
  assert.equal(monthMoney({...s,settings:{...s.settings,goal:0}},'2026-11-12').left,0);
  assert.equal(monthMoney(s,'2026-02-10').end,'2026-02-28');
  assert.match(statsView(s,'2026-11-12').text,/Мои деньги за месяц<\/b> \(доля 40%\)\nЗаработано: 2 000 ₽, ещё в записях: 1 000 ₽\nЦель 5 000 ₽: осталось 2 000 ₽ — примерно 2 визита/);
});

test('Settings: share and goal are validated; old copies without them get defaults',()=>{
  const base=initialState().settings,{share,goal,...old}=base;
  assert.deepEqual([validateSettings(old).share,validateSettings(old).goal],[100,0]);
  for(const bad of [{share:0},{share:101},{share:50.5},{goal:-1},{goal:'5000'}])assert.throws(()=>validateSettings({...base,...bad}),/Доля|цель/);
  assert.equal(validateSettings({...base,share:45,goal:120000}).share,45);
});

test('Due clients: who to invite into a free window, most overdue first, nobody with a booking',()=>{
  const s=initialState();
  s.records=[visit('1','Анна','2026-09-01','done'),visit('2','Анна','2026-09-29','done'), // интервал 28, прошло 44 — опоздание 16
    visit('3','Борис','2026-10-20','done'), // 23 дня, без интервала: ждём с 23-го
    visit('4','Вера','2026-10-01','done'),visit('5','Вера','2026-11-20','confirmed'), // уже записана
    visit('6','Глеб','2026-11-05','done'), // был неделю назад
    visit('7','Дина','2026-08-01','noshow')]; // ни разу не дошла
  assert.deepEqual(dueClients(s,'2026-11-12').map(c=>c.name),['Анна','Борис']);
  assert.equal(dueClients(s,'2026-11-12',1).length,1);
});

test('Morning plan: today with free windows names who to invite; other days and full days stay quiet',()=>{
  const s=initialState();
  s.records=[visit('1','Анна','2026-09-01','done'),visit('2','Анна','2026-09-29','done')];
  assert.match(dayView(s,'2026-11-12','2026-11-12').text,/Позвать в окна:<\/b> Анна \(44 дня\)/);
  assert.doesNotMatch(dayView(s,'2026-11-13','2026-11-12').text,/Позвать/);
  s.dayOverrides['2026-11-12']={closed:true};
  assert.doesNotMatch(dayView(s,'2026-11-12','2026-11-12').text,/Позвать/);
});

test('Next visit: usual interval first, same weekday and time when free, otherwise the nearest window',async()=>{
  const {nextVisitOptions}=await import('../shared.mjs');
  const s=initialState();
  s.records=[visit('1','Анна','2026-09-14','done'),visit('2','Анна','2026-10-05','done'),visit('3','Анна','2026-10-26','done')]; // каждые 3 недели
  const r=s.records[2],opts=nextVisitOptions(s,r,'2026-10-26');
  assert.deepEqual(opts.map(o=>[o.weeks,o.date,o.time,o.exact]),[[3,'2026-11-16','12:00',true],[4,'2026-11-23','12:00',true],[6,'2026-12-07','12:00',true]]);
  assert.equal(opts[0].usual,true);
  s.records.push(visit('4','Борис','2026-11-16','confirmed')); // 12:00 через 3 недели занято
  assert.equal(nextVisitOptions(s,r,'2026-10-26')[0].time,'11:00'); // ближайшее к привычному времени, при равенстве — раньше
  s.dayOverrides['2026-11-16']={closed:true,start:'10:00',end:'19:00'};
  assert.equal(nextVisitOptions(s,r,'2026-10-26')[0].date,'2026-11-17'); // выходной — следующий день
});

test('Money: month expenses are subtracted from earnings, other months are ignored',()=>{
  const s=initialState();s.settings.share=50;
  s.records=[visit('1','Анна','2026-11-03','done',4000)];
  s.expenses=[{id:'a',date:'2026-11-01',amount:1500,kind:'Аренда',note:''},{id:'b',date:'2026-10-31',amount:9000,kind:'Аренда',note:''}];
  const m=monthMoney(s,'2026-11-12');
  assert.deepEqual([m.earned,m.spent,m.net],[2000,1500,500]);
});

test('CSV: records and clients tables for Excel, formulas neutralised, online source named',async()=>{
  const {recordsCsv,clientsCsv}=await import('../shared.mjs');
  const s=initialState();
  s.records=[{...visit('1','=HYPERLINK("x")','2026-11-01','done'),phone:'+7 900'},{...visit('2','Анна','2026-11-10','confirmed'),origin:'online'}];
  s.clientNotes={'Анна':'Без бороды'};
  const r=recordsCsv(s).split('\r\n');
  assert.equal(r[0].charCodeAt(0),0xFEFF);assert.equal(r.length,3);
  assert.match(r[1],/"'=HYPERLINK\(""x""\)"/);assert.match(r[2],/"Онлайн-запись"/);
  const c=clientsCsv(s,'2026-11-12').split('\r\n');
  assert.match(c[0],/Ходит раз в, дней/);assert.match(c.find(l=>l.includes('Анна')),/"Без бороды"/);
});
