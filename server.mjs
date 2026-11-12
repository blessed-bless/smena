import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {Store} from './lib/store.mjs';
import {AppError,verifyTelegram,upsertRecord,validateSettings,validateBackup,validateDayOverride,validateWaiting,validateExpense,localNow,initialState} from './lib/core.mjs';
import {bookingCabinet,bookingInfo,slotsFor,book,cancelBooking,joinWaitlist,keyHash} from './lib/booking.mjs';
import {startBot} from './lib/bot.mjs';
import {createSyncHub} from './lib/sync.mjs';
import {createYclients,tokenBox,RECOVERY_URL} from './lib/yclients.mjs';
import {recordsCsv,clientsCsv} from './shared.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export const VERSION='0.7.0';
const FILES={'/':'index.html','/demo':'index.html','/shared.mjs':'shared.mjs','/app.js':'app.js','/app.css':'app.css','/icon.svg':'icon.svg','/book':'book.html','/book.js':'book.js','/book.css':'book.css'};
const isLive=r=>r&&!['cancelled','noshow'].includes(r.status);
const validZone=z=>{try{return typeof z==='string'&&z&&new Intl.DateTimeFormat('en',{timeZone:z})&&z}catch{return null}};
// emit(событие, кабинет, …) — сообщает боту об онлайн-записях, отменах и листе ожидания. Ошибка отправки не ломает ответ.
// sync — либо общий узел синхронизации (get(id) на каждый кабинет), либо один экземпляр для кабинета владельца (тесты).
export function createApp(config,store,sync=null,yc=createYclients({partnerToken:config.yclients?.partnerToken}),box=tokenBox(config.tokenSecret||config.botToken),emit=()=>{}){
  const fire=(...a)=>{try{Promise.resolve(emit(...a)).catch(e=>console.error('Event failed:',e?.message))}catch(e){console.error('Event failed:',e?.message)}};
  const origin=config.publicUrl?new URL(config.publicUrl).origin:null,rate=new Map(),tickets=new Map();
  // За прокси адрес клиента — тот, что добавил сам прокси: CF-Connecting-IP или последний в X-Forwarded-For. Первый клиент может подделать.
  const ip=req=>(config.trustProxy?String(req.headers['cf-connecting-ip']||String(req.headers['x-forwarded-for']||'').split(',').pop()).trim():'')||req.socket.remoteAddress||'unknown';
  const syncOf=id=>sync?.get?sync.get(id):id===store.ownerId?sync:null;
  // Не больше limit попыток за окно ms на ключ: защита входа от перебора.
  function throttle(key,limit,ms,message){
    const now=Date.now();if(rate.size>2000)for(const [k,v]of rate)if(now-v.at>v.ms)rate.delete(k);
    const r=rate.get(key);if(r&&now-r.at<r.ms){if(++r.count>limit)throw new AppError('RATE',message,429)}else rate.set(key,{at:now,ms,count:1});
  }
  // Вход через YCLIENTS идёт в несколько шагов. Между ними токен лежит только в памяти, 10 минут, под случайным билетом.
  function ticketFor(id,data){for(const [k,t]of tickets)if(t.expires<Date.now()||t.tgId===id)tickets.delete(k);const key=randomBytes(24).toString('base64url');tickets.set(key,Object.assign(data,{key,tgId:id,expires:Date.now()+600000}));return key}
  function ticket(key){const t=typeof key==='string'&&tickets.get(key);if(!t||t.expires<Date.now())throw new AppError('YC_TICKET','Вход устарел. Введите логин и пароль ещё раз.',400);return t}
  // Подключает аккаунт YCLIENTS: к кабинету, куда у человека уже есть доступ, или к новому кабинету.
  async function connect(res,t,company,staff){
    let cabinet=store.cabinetOf(t.tgId);
    if(cabinet!==null&&cabinet!==t.tgId)throw new AppError('FORBIDDEN','К этому кабинету YCLIENTS подключает его хозяин.',403);
    const created=cabinet===null;
    // Новый мастер сразу получает утренний план в Telegram: ради этого бот и нужен.
    if(created){const state=initialState(),zone=validZone(company.timeZone);if(zone)state.settings.timeZone=zone;state.settings.morning=true;cabinet=t.tgId;store.createCabinet(cabinet,state)}
    const db=store.scope(cabinet);
    db.account({token:box.seal(t.token),ycUserId:t.ycUser.id,name:t.ycUser.name,companyId:company.id,company:company.title,staffId:staff.id,staff:staff.name});
    db.meta('sync_seeded','');db.meta('sync_error','');db.log('Вход через YCLIENTS');
    // Новому кабинету сразу подставляем услуги мастера из YCLIENTS. Не получилось — остаются стандартные, вход не прерываем.
    if(created)try{const services=await yc.services(t.token,company.id,staff.id);if(services.length)db.mutate(db.read().revision,state=>({...state,settings:validateSettings({...state.settings,services})}),'Услуги из YCLIENTS')}catch(e){if(!e.status)console.error('Services import failed:',e?.message)}
    tickets.delete(t.key);
    const s=syncOf(cabinet);if(s?.mode())await s.run();
    const session=store.createSession(t.tgId);res.setHeader('Set-Cookie',cookieFor(session));
    return {ok:true,created,session,owner:cabinet===t.tgId};
  }
  // Ссылки онлайн-записи: через бота (адрес не меняется, клиент получает напоминания) и прямая страница.
  function bookingLinks(db,state){
    if(!state.settings.booking.enabled)return null;
    const slug=db.bookingSlug(),base=(config.publicUrl||'').replace(/\/+$/,'');
    return {slug,telegram:/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername||'')?`https://t.me/${config.botUsername}?start=book_${slug}`:null,web:base?`${base}/book?c=${slug}`:null};
  }
  const cookieFor=session=>`smena=${session}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800${origin?.startsWith('https:')?'; Secure':''}`;
  const PUBLIC=new Set(['/api/session','/api/yc/login','/api/yc/staff','/api/yc/connect','/api/book/info','/api/book/slots','/api/book','/api/book/cancel','/api/book/wait']);
  // Клиент на странице записи: из Telegram (подпись initData) или из обычного браузера (тогда только телефон).
  const client=body=>body.initData?verifyTelegram(body.initData,config.botToken):null;
  const clientName=u=>[u?.first_name,u?.last_name].filter(Boolean).join(' ');
  return http.createServer(async(req,res)=>{
    const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",'Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
    for(const [k,v]of Object.entries(headers))res.setHeader(k,v);
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const head=req.method==='HEAD',get=req.method==='GET'||head;
      if(get&&path==='/health'){const s=syncOf(store.ownerId)?.status();return json(200,{status:'ok',version:VERSION,yclientsConnected:!!(s?.mode&&s.at&&!s.error)})}
      if(req.method==='GET'&&path==='/api/public')return json(200,{botUsername:config.botUsername||'',timeZone:store.read().settings.timeZone,ycLogin:!!yc?.enabled,recoveryUrl:RECOVERY_URL});
      if(get&&FILES[path]){
        // Статика отдаётся с ETag: при повторном открытии Mini App браузер получает 304 вместо 60+ КБ.
        const file=FILES[path],mime=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/javascript';
        const content=await readFile(resolve(ROOT,file)),etag='"'+createHash('sha1').update(content).digest('base64url')+'"';
        res.setHeader('Cache-Control','no-cache');res.setHeader('ETag',etag);
        if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return}
        res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Content-Length':content.length});res.end(head?undefined:content);return;
      }
      if(!path.startsWith('/api/'))return json(404,{error:'NOT_FOUND',message:'Страница не найдена.'});
      if(!['GET','POST'].includes(req.method))return json(405,{error:'METHOD',message:'Недоступный метод.'});
      if(req.method==='POST'){
        const allowedOrigin=origin||`http://127.0.0.1:${config.port}`;
        if(req.headers.origin!==allowedOrigin)throw new AppError('ORIGIN','Недопустимый источник запроса.',403);
        if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError('TYPE','Ожидается JSON.',415);
      }
      const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('smena='))?.slice(6);
      const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
      const open=PUBLIC.has(path),userId=open?null:store.sessionUser(bearer||cookie);
      if(!open&&userId===null)throw new AppError('AUTH','Откройте приложение заново из Telegram.',401);
      let body={};
      if(req.method==='POST'){let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>(['/api/import','/api/import-preview'].includes(path)?32*1024*1024:32768))throw new AppError('SIZE','Слишком большой запрос.',413);chunks.push(chunk)}try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{throw new AppError('JSON','Не удалось прочитать запрос.')}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('JSON','Некорректный запрос.');
      }
      if(path==='/api/session'&&req.method==='POST'){
        throttle('ip:'+ip(req),40,60000,'Слишком много попыток. Подождите минуту.');
        const user=verifyTelegram(body.initData,config.botToken),cabinet=store.cabinetOf(user.id);
        if(cabinet===null)throw new AppError(yc?.enabled?'NO_CABINET':'FORBIDDEN',yc?.enabled?'Войдите своим аккаунтом YCLIENTS — расписание подтянется само.':'Это личный кабинет. Попросите владельца выдать приглашение.',403);
        const session=store.createSession(user.id);res.setHeader('Set-Cookie',cookieFor(session));
        return json(200,{ok:true,owner:user.id===cabinet,session});
      }
      if(path==='/api/book/info'&&req.method==='GET'){const db=bookingCabinet(store,url.searchParams.get('c'));return json(200,{...bookingInfo(db),botUsername:config.botUsername||''})}
      if(path==='/api/book/slots'&&req.method==='GET'){
        throttle('slots:'+ip(req),120,60000,'Слишком много запросов. Подождите минуту.');
        const db=bookingCabinet(store,url.searchParams.get('c'));return json(200,{slots:slotsFor(db,Number(url.searchParams.get('s')))});
      }
      if(path==='/api/book'&&req.method==='POST'){
        if(body.website)throw new AppError('INVALID','Не удалось записаться. Обновите страницу.'); // ловушка для ботов: поле скрыто от людей
        throttle('book:'+ip(req),8,3600000,'Слишком много записей с этого устройства. Попробуйте через час или напишите мастеру.');
        const db=bookingCabinet(store,body.c),user=client(body);
        throttle('slug:'+db.cabinet,60,86400000,'Онлайн-запись временно недоступна. Напишите мастеру напрямую.');
        const {record,key}=book(db,{service:body.service,date:body.date,time:body.time,name:body.name||clientName(user),phone:body.phone},{clientTg:user?.id||null});
        fire('booked',db,record);
        return json(200,{ok:true,key,telegram:!!user,record:{date:record.date,time:record.time,service:record.service,duration:record.duration,price:record.price}});
      }
      if(path==='/api/book/cancel'&&req.method==='POST'){
        throttle('cancel:'+ip(req),20,3600000,'Слишком много попыток. Подождите час.');
        if(typeof body.key!=='string'||body.key.length<10||body.key.length>100)throw new AppError('INVALID','Ссылка отмены повреждена.');
        const db=bookingCabinet(store,body.c),h=keyHash(body.key),record=cancelBooking(db,r=>r.cancelKey===h);
        fire('cancelled',db,record,'client');return json(200,{ok:true});
      }
      if(path==='/api/book/wait'&&req.method==='POST'){
        if(body.website)throw new AppError('INVALID','Не удалось отправить. Обновите страницу.');
        throttle('book:'+ip(req),8,3600000,'Слишком много заявок с этого устройства. Попробуйте через час.');
        const db=bookingCabinet(store,body.c),user=client(body);
        const entry=joinWaitlist(db,{name:body.name||clientName(user),phone:body.phone,service:body.service,note:body.note},{clientTg:user?.id||null});
        fire('waiting',db,entry);return json(200,{ok:true});
      }
      if(path==='/api/yc/login'&&req.method==='POST'){
        throttle('ip:'+ip(req),40,60000,'Слишком много попыток. Подождите минуту.');
        const user=verifyTelegram(body.initData,config.botToken);
        throttle('yc:'+user.id,10,600000,'Слишком много попыток входа. Подождите 10 минут или восстановите пароль в YCLIENTS.');
        const login=typeof body.login==='string'?body.login.trim():'',password=typeof body.password==='string'?body.password:'';
        if(!login||login.length>100||!password||password.length>200)throw new AppError('INVALID','Введите телефон или почту и пароль от YCLIENTS.');
        let twofa=null;
        if(body.code!==undefined){if(typeof body.uuid!=='string'||body.uuid.length>100||typeof body.code!=='string'||!/^\d{3,10}$/.test(body.code.trim()))throw new AppError('INVALID','Введите код из письма YCLIENTS.');twofa={uuid:body.uuid,code:body.code.trim()}}
        const result=await yc.login(login,password,twofa);
        if(result.need2fa)return json(200,{need2fa:result.need2fa});
        const companies=await yc.companies(result.user.token);
        if(!companies.length)throw new AppError('YC_EMPTY','В этом аккаунте YCLIENTS нет филиалов. Войдите аккаунтом, под которым вы работаете в салоне.');
        const t={token:result.user.token,ycUser:result.user,companies};t.key=ticketFor(user.id,t);
        // Один филиал и мастер, привязанный к этому пользователю, — подключаем сразу, без вопросов.
        if(companies.length===1){
          const staff=await yc.staff(result.user.token,companies[0].id),mine=staff.filter(x=>x.userId===result.user.id);
          if(mine.length===1)return json(200,await connect(res,t,companies[0],mine[0]));
          t.staff={[companies[0].id]:staff};
          return json(200,{choose:{ticket:t.key,name:result.user.name,companies,staff,companyId:companies[0].id}});
        }
        return json(200,{choose:{ticket:t.key,name:result.user.name,companies}});
      }
      if(path==='/api/yc/staff'&&req.method==='POST'){
        const t=ticket(body.ticket),company=t.companies.find(c=>c.id===body.companyId);
        if(!company)throw new AppError('INVALID','Выберите филиал из списка.');
        t.staff||={};t.staff[company.id]||=await yc.staff(t.token,company.id);
        return json(200,{staff:t.staff[company.id],mine:t.staff[company.id].find(x=>x.userId===t.ycUser.id)?.id??null});
      }
      if(path==='/api/yc/connect'&&req.method==='POST'){
        const t=ticket(body.ticket),company=t.companies.find(c=>c.id===body.companyId),staff=t.staff?.[body.companyId]?.find(x=>x.id===body.staffId);
        if(!company||!staff)throw new AppError('INVALID','Выберите филиал и себя в списке мастеров.');
        return json(200,await connect(res,t,company,staff));
      }
      if(!open&&store.sessionUser(bearer||cookie)!==userId)throw new AppError('AUTH','Доступ изменился. Откройте приложение заново из Telegram.',401);
      const cabinet=store.cabinetOf(userId),db=store.scope(cabinet),master=userId===cabinet,sync1=syncOf(cabinet);
      if(path==='/api/state'&&req.method==='GET'){
        const a=db.account(),state=db.read();
        return json(200,{...state,owner:master,hasFriend:db.friend()!==null,sync:sync1?.status()||null,today:localNow(state.settings.timeZone).date,
          account:a?{name:a.name,company:a.company,staff:a.staff}:null,canDelete:master&&cabinet!==store.ownerId,ycLogin:!!yc?.enabled,booking:bookingLinks(db,state)});
      }
      if(path==='/api/yc/disconnect'&&req.method==='POST'){
        if(!master)throw new AppError('FORBIDDEN','Отключить YCLIENTS может хозяин кабинета.',403);
        db.account(null);sync1?.reset?.();db.log('YCLIENTS отключён');return json(200,{...db.read(),sync:sync1?.status()||null});
      }
      if(path==='/api/cabinet-delete'&&req.method==='POST'){
        if(!master||cabinet===store.ownerId)throw new AppError('FORBIDDEN','Этот кабинет удалить нельзя.',403);
        if(body.confirm!=='удалить')throw new AppError('INVALID','Напишите «удалить», чтобы подтвердить.');
        db.deleteCabinet();sync?.forget?.(cabinet);res.setHeader('Set-Cookie','smena=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0');return json(200,{ok:true});
      }
      // В Telegram на iPhone файл из Mini App не скачать — бот присылает его в чат, откуда его можно открыть или сохранить.
      if(path==='/api/send-file'&&req.method==='POST'){
        throttle('file:'+userId,10,600000,'Слишком много файлов подряд. Подождите несколько минут.');
        const state=db.read(),today=localNow(state.settings.timeZone).date;
        const file={records:['smena-zapisi-'+today+'.csv','Все записи — таблица для Excel или Google Таблиц.',()=>recordsCsv(state)],clients:['smena-klienty-'+today+'.csv','База клиентов: телефоны, визиты, средний интервал, заметки.',()=>clientsCsv(state,today)],backup:['smena-backup-'+today+'.json','Резервная копия «Смены». Восстановить: Настройки → Восстановить из файла.',()=>JSON.stringify({format:'smena-v2',exportedAt:new Date().toISOString(),...state})]}[body.kind];
        if(!file)throw new AppError('INVALID','Неизвестный файл.');
        if(await emit('file',db,{to:userId,name:file[0],caption:file[1],content:file[2]()})!==true)throw new AppError('BOT_OFF','Бот сейчас не может отправить файл. Попробуйте позже.',503);
        return json(200,{ok:true});
      }
      if(path==='/api/audit'&&req.method==='GET')return json(200,{events:db.audit()});
      if(path==='/api/export'&&req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="smena-backup.json"');return json(200,{format:'smena-v2',exportedAt:new Date().toISOString(),...db.read()})}
      if(path==='/api/record'&&req.method==='POST'){
        let before=null,saved=null;
        const next=db.mutate(body.revision,state=>{before=structuredClone(state.records.find(r=>r.id===body.record?.id)||null);saved=upsertRecord(state,body.record);return state},'Сохранение записи');
        if(before?.clientTg&&isLive(before)&&isLive(saved)&&(before.date!==saved.date||before.time!==saved.time))fire('moved',db,saved);
        if(before&&isLive(before)&&saved.status==='cancelled')fire('cancelled',db,saved,'master');
        return json(200,next);
      }
      if(path==='/api/cancel'&&req.method==='POST'){let saved;const next=db.mutate(body.revision,state=>{const r=saved=state.records.find(r=>r.id===body.id);if(!r)throw new AppError('NOT_FOUND','Запись не найдена.',404);if(r.source==='yclients')throw new AppError('READONLY','Запись из YCLIENTS меняется только в YCLIENTS.',403);r.status='cancelled';r.updatedAt=new Date().toISOString();return state},'Отмена визита');fire('cancelled',db,saved,'master');return json(200,next)}
      if(path==='/api/settings'&&req.method==='POST'){const next=db.mutate(body.revision,state=>({...state,settings:validateSettings(body.settings)}),'Изменение настроек');return json(200,next)}
      if(path==='/api/sync-now'&&req.method==='POST'){if(!sync1?.mode())throw new AppError('SYNC_OFF','Синхронизация с YCLIENTS не настроена.');const status=await sync1.run();return json(200,{...db.read(),sync:status})}
      if(path==='/api/sync-config'&&req.method==='POST'){
        if(!master)throw new AppError('FORBIDDEN','Подключение меняет хозяин кабинета.',403);
        if(!sync1)throw new AppError('SYNC_OFF','Синхронизация недоступна на этом сервере.');
        if(body.url===null){const status=sync1.configure(null);return json(200,{...db.read(),sync:status})}
        if(!sync1.configure(body.url))throw new AppError('INVALID','Вставьте ссылку https:// — «Секретный адрес в формате iCal».');
        const status=await sync1.run();return json(200,{...db.read(),sync:status});
      }
      if(path==='/api/booking-reset'&&req.method==='POST'){
        if(!master)throw new AppError('FORBIDDEN','Ссылку записи меняет хозяин кабинета.',403);
        db.bookingSlug(true);db.log('Новая ссылка онлайн-записи');return json(200,{booking:bookingLinks(db,db.read())});
      }
      if(path==='/api/waitlist'&&req.method==='POST'){
        const next=db.mutate(body.revision,state=>{
          if(body.remove!==undefined){const before=state.waitlist.length;state.waitlist=state.waitlist.filter(w=>w.id!==body.remove);if(state.waitlist.length===before)throw new AppError('NOT_FOUND','Клиента уже нет в листе ожидания.',404);return state}
          const old=body.entry?.id&&state.waitlist.find(w=>w.id===body.entry.id);if(body.entry?.id&&!old)throw new AppError('NOT_FOUND','Клиента уже нет в листе ожидания.',404);
          const entry=validateWaiting({...body.entry,clientTg:old?.clientTg,origin:old?.origin,createdAt:old?.createdAt},state);
          state.waitlist=state.waitlist.filter(w=>w.id!==entry.id).concat(entry);return state;
        },'Лист ожидания');return json(200,next);
      }
      if(path==='/api/expense'&&req.method==='POST'){
        if(!master)throw new AppError('FORBIDDEN','Расходы ведёт хозяин кабинета.',403);
        const next=db.mutate(body.revision,state=>{
          if(body.remove!==undefined){state.expenses=state.expenses.filter(x=>x.id!==body.remove);return state}
          if(body.expense?.id&&!state.expenses.some(x=>x.id===body.expense.id))throw new AppError('NOT_FOUND','Расход не найден.',404);
          const x=validateExpense(body.expense,state);state.expenses=state.expenses.filter(e=>e.id!==x.id).concat(x);return state;
        },'Расходы');return json(200,next);
      }
      if(path==='/api/backups'&&req.method==='GET')return json(200,{backups:db.backups()});
      if(path==='/api/import-preview'&&req.method==='POST'){
        const data=validateBackup(body.backup),dates=data.records.map(r=>r.date).sort();
        return json(200,{records:data.records.length,clients:new Set(data.records.filter(r=>r.type!=='block').map(r=>r.name)).size,firstDate:dates[0]||null,lastDate:dates.at(-1)||null});
      }
      if(path==='/api/import'&&req.method==='POST')return json(200,db.restore(body.revision,validateBackup(body.backup,(s=>new Set([...s.records,...s.waitlist].map(x=>x.clientTg).filter(Boolean)))(db.read()))));
      if(path==='/api/restore-copy'&&req.method==='POST'){
        if(!Number.isSafeInteger(body.id)||body.id<=0)throw new AppError('INVALID','Выберите сохранённую копию.');
        const data=validateBackup({...db.backup(body.id),format:'smena-v2'});
        return json(200,db.restore(body.revision,data));
      }
      if(path==='/api/day'&&req.method==='POST'){
        const next=db.mutate(body.revision,state=>{
          const override=validateDayOverride(body.date,body.override,state);
          if(override){if(Object.keys(state.dayOverrides).length>=1000&&!Object.hasOwn(state.dayOverrides,body.date))throw new AppError('LIMIT','Достигнут лимит индивидуальных графиков.');state.dayOverrides[body.date]=override}
          else delete state.dayOverrides[body.date];
          return state;
        },'График отдельного дня');return json(200,next);
      }
      if(path==='/api/client-note'&&req.method==='POST'){if(typeof body.name!=='string'||body.name.length>80||typeof body.note!=='string'||body.note.length>1000||!db.read().records.some(r=>r.type!=='block'&&r.name===body.name))throw new AppError('INVALID','Проверьте заметку клиента.');const next=db.mutate(body.revision,state=>{Object.defineProperty(state.clientNotes,body.name,{value:body.note.trim(),enumerable:true,writable:true,configurable:true});return state},'Заметка о клиенте');return json(200,next)}
      if(path==='/api/invite'&&req.method==='POST'){if(!master)throw new AppError('FORBIDDEN','Приглашение создаёт хозяин кабинета.',403);if(db.friend()!==null)throw new AppError('ACCESS_EXISTS','Помощник уже есть: сначала закройте ему доступ.');if(!/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername||''))throw new AppError('CONFIG','Имя бота неизвестно: задайте BOT_USERNAME или запустите бота с PUBLIC_URL.',503);return json(200,{url:`https://t.me/${config.botUsername}?start=join_${db.createInvite()}`,expiresIn:86400})}
      if(path==='/api/revoke'&&req.method==='POST'){if(!master)throw new AppError('FORBIDDEN','Доступ меняет хозяин кабинета.',403);db.revokeFriend();return json(200,{ok:true})}
      return json(404,{error:'NOT_FOUND',message:'Действие не найдено.'});
    }catch(e){if(!e.status)console.error('Request failed:',e?.message);if(res.headersSent)return res.end();return json(e.status||500,{error:e.code||'SERVER',message:e.status?e.message:'Не удалось выполнить действие. Повторите попытку.'})}
  });
}
export async function loadConfig(){
  let file={};if(process.env.SMENA_CONFIG)file=JSON.parse((await readFile(process.env.SMENA_CONFIG,'utf8')).replace(/^\uFEFF/,''));
  return {...file,botToken:process.env.BOT_TOKEN||file.botToken,botUsername:process.env.BOT_USERNAME||file.botUsername,ownerId:Number(process.env.OWNER_TELEGRAM_ID||file.ownerId),publicUrl:process.env.PUBLIC_URL||file.publicUrl,port:Number(process.env.PORT||file.port||8732),trustProxy:process.env.TRUST_PROXY==='1'||file.trustProxy===true,tokenSecret:process.env.TOKEN_SECRET||file.tokenSecret,yclients:{partnerToken:process.env.YCLIENTS_PARTNER_TOKEN||file.yclients?.partnerToken,userToken:process.env.YCLIENTS_USER_TOKEN||file.yclients?.userToken,companyId:process.env.YCLIENTS_COMPANY_ID||file.yclients?.companyId,staffId:process.env.YCLIENTS_STAFF_ID||file.yclients?.staffId},host:process.env.HOST||file.host||'127.0.0.1',dataDir:process.env.DATA_DIR||file.dataDir||resolve(ROOT,'data')};
}
async function main(){
  const config=await loadConfig();if(!config.botToken||!Number.isSafeInteger(config.ownerId)||config.ownerId<=0)throw Error('Set BOT_TOKEN and OWNER_TELEGRAM_ID, or SMENA_CONFIG.');
  await mkdir(config.dataDir,{recursive:true});const store=new Store(resolve(config.dataDir,'smena.sqlite'),config.ownerId);
  let bot=null;const sync=createSyncHub({config,store,box:tokenBox(config.tokenSecret||config.botToken),notify:(scoped,text)=>bot?bot.notify(text,scoped):Promise.resolve()});
  const server=createApp(config,store,sync,undefined,undefined,(name,db,...a)=>bot?.events(name,db,...a));server.listen(config.port,config.host,()=>console.log(`Smena listening on port ${config.port}`));
  bot=config.publicUrl?startBot(config,store):null;
  const syncLoop=sync.start();
  const snap=()=>{try{store.snapshot(resolve(config.dataDir,'snapshots'))}catch(e){console.error('Snapshot failed:',e.message)}};snap();const snapTimer=setInterval(snap,6*3600*1000);snapTimer.unref();
  // Сбой в фоновой задаче не должен ронять сервер молча: пишем причину (без данных запроса) и работаем дальше.
  process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e?.message||e));
  const shutdown=()=>{bot?.stop();syncLoop.stop();clearInterval(snapTimer);server.close(()=>{store.close();process.exit(0)});server.closeIdleConnections?.()};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
