import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Store} from './lib/store.mjs';
import {AppError,verifyTelegram,upsertRecord,validateSettings,validateBackup,validateDayOverride,localNow} from './lib/core.mjs';
import {startBot} from './lib/bot.mjs';
import {createSync} from './lib/sync.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export const VERSION='0.5.0';
const FILES={'/':'index.html','/demo':'index.html','/shared.mjs':'shared.mjs','/app.js':'app.js','/app.css':'app.css','/icon.svg':'icon.svg'};
export function createApp(config,store,sync=null){
  const origin=config.publicUrl?new URL(config.publicUrl).origin:null,rate=new Map();
  return http.createServer(async(req,res)=>{
    const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",'Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
    for(const [k,v]of Object.entries(headers))res.setHeader(k,v);
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const head=req.method==='HEAD',get=req.method==='GET'||head;
      if(get&&path==='/health'){const s=sync?.status();return json(200,{status:'ok',version:VERSION,yclientsConnected:!!(s?.mode&&s.at&&!s.error)})}
      if(req.method==='GET'&&path==='/api/public')return json(200,{botUsername:config.botUsername||'',timeZone:store.read().settings.timeZone});
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
      const userId=path==='/api/session'?null:store.sessionUser(bearer||cookie);
      if(path!=='/api/session'&&userId===null)throw new AppError('AUTH','Откройте приложение заново из Telegram.',401);
      let body={};
      if(req.method==='POST'){let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>(['/api/import','/api/import-preview'].includes(path)?32*1024*1024:32768))throw new AppError('SIZE','Слишком большой запрос.',413);chunks.push(chunk)}try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{throw new AppError('JSON','Не удалось прочитать запрос.')}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('JSON','Некорректный запрос.');
      }
      if(path==='/api/session'&&req.method==='POST'){
        const forwarded=config.trustProxy?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'',ip=forwarded||req.socket.remoteAddress||'unknown',now=Date.now();
        if(rate.size>1000)for(const [key,v]of rate)if(now-v.at>60000)rate.delete(key);
        const limit=rate.get(ip);if(limit&&now-limit.at<60000){if(++limit.count>40)throw new AppError('RATE','Слишком много попыток. Подождите минуту.',429)}else rate.set(ip,{at:now,count:1});
        const user=verifyTelegram(body.initData,config.botToken);if(!store.allowed(user.id))throw new AppError('FORBIDDEN','Это личный кабинет. Попросите владельца выдать приглашение.',403);
        const session=store.createSession(user.id);res.setHeader('Set-Cookie',`smena=${session}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800${origin?.startsWith('https:')?'; Secure':''}`);
        return json(200,{ok:true,owner:user.id===Number(config.ownerId),session});
      }
      if(path!=='/api/session'&&store.sessionUser(bearer||cookie)!==userId)throw new AppError('AUTH','Доступ изменился. Откройте приложение заново из Telegram.',401);
      if(path==='/api/state'&&req.method==='GET')return json(200,{...store.read(),owner:userId===Number(config.ownerId),hasFriend:store.friend()!==null,sync:sync?.status()||null,today:localNow(store.read().settings.timeZone).date});
      if(path==='/api/audit'&&req.method==='GET')return json(200,{events:store.audit()});
      if(path==='/api/export'&&req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="smena-backup.json"');return json(200,{format:'smena-v2',exportedAt:new Date().toISOString(),...store.read()})}
      if(path==='/api/record'&&req.method==='POST'){
        const next=store.mutate(body.revision,state=>{upsertRecord(state,body.record);return state},'Сохранение записи');return json(200,next);
      }
      if(path==='/api/cancel'&&req.method==='POST'){const next=store.mutate(body.revision,state=>{const r=state.records.find(r=>r.id===body.id);if(!r)throw new AppError('NOT_FOUND','Запись не найдена.',404);if(r.source==='yclients')throw new AppError('READONLY','Запись из YCLIENTS меняется только в YCLIENTS.',403);r.status='cancelled';r.updatedAt=new Date().toISOString();return state},'Отмена визита');return json(200,next)}
      if(path==='/api/settings'&&req.method==='POST'){const next=store.mutate(body.revision,state=>({...state,settings:validateSettings(body.settings)}),'Изменение настроек');return json(200,next)}
      if(path==='/api/sync-now'&&req.method==='POST'){if(!sync?.mode())throw new AppError('SYNC_OFF','Синхронизация с YCLIENTS не настроена.');const status=await sync.run();return json(200,{...store.read(),sync:status})}
      if(path==='/api/sync-config'&&req.method==='POST'){
        if(userId!==Number(config.ownerId))throw new AppError('FORBIDDEN','Подключение меняет владелец.',403);
        if(!sync)throw new AppError('SYNC_OFF','Синхронизация недоступна на этом сервере.');
        if(body.url===null){const status=sync.configure(null);return json(200,{...store.read(),sync:status})}
        if(!sync.configure(body.url))throw new AppError('INVALID','Вставьте ссылку https:// — «Секретный адрес в формате iCal».');
        const status=await sync.run();return json(200,{...store.read(),sync:status});
      }
      if(path==='/api/backups'&&req.method==='GET')return json(200,{backups:store.backups()});
      if(path==='/api/import-preview'&&req.method==='POST'){
        const data=validateBackup(body.backup),dates=data.records.map(r=>r.date).sort();
        return json(200,{records:data.records.length,clients:new Set(data.records.filter(r=>r.type!=='block').map(r=>r.name)).size,firstDate:dates[0]||null,lastDate:dates.at(-1)||null});
      }
      if(path==='/api/import'&&req.method==='POST')return json(200,store.restore(body.revision,validateBackup(body.backup)));
      if(path==='/api/restore-copy'&&req.method==='POST'){
        if(!Number.isSafeInteger(body.id)||body.id<=0)throw new AppError('INVALID','Выберите сохранённую копию.');
        const data=validateBackup({...store.backup(body.id),format:'smena-v2'});
        return json(200,store.restore(body.revision,data));
      }
      if(path==='/api/day'&&req.method==='POST'){
        const next=store.mutate(body.revision,state=>{
          const override=validateDayOverride(body.date,body.override,state);
          if(override){if(Object.keys(state.dayOverrides).length>=1000&&!Object.hasOwn(state.dayOverrides,body.date))throw new AppError('LIMIT','Достигнут лимит индивидуальных графиков.');state.dayOverrides[body.date]=override}
          else delete state.dayOverrides[body.date];
          return state;
        },'График отдельного дня');return json(200,next);
      }
      if(path==='/api/client-note'&&req.method==='POST'){if(typeof body.name!=='string'||body.name.length>80||typeof body.note!=='string'||body.note.length>1000||!store.read().records.some(r=>r.type!=='block'&&r.name===body.name))throw new AppError('INVALID','Проверьте заметку клиента.');const next=store.mutate(body.revision,state=>{Object.defineProperty(state.clientNotes,body.name,{value:body.note.trim(),enumerable:true,writable:true,configurable:true});return state},'Заметка о клиенте');return json(200,next)}
      if(path==='/api/invite'&&req.method==='POST'){if(userId!==Number(config.ownerId))throw new AppError('FORBIDDEN','Приглашение создаёт владелец.',403);if(store.friend()!==null)throw new AppError('ACCESS_EXISTS','Доступ второму пользователю уже выдан.');if(!/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername||''))throw new AppError('CONFIG','Имя бота неизвестно: задайте BOT_USERNAME или запустите бота с PUBLIC_URL.',503);return json(200,{url:`https://t.me/${config.botUsername}?start=join_${store.createInvite()}`,expiresIn:86400})}
      if(path==='/api/revoke'&&req.method==='POST'){if(userId!==Number(config.ownerId))throw new AppError('FORBIDDEN','Доступ меняет владелец.',403);store.revokeFriend();return json(200,{ok:true})}
      return json(404,{error:'NOT_FOUND',message:'Действие не найдено.'});
    }catch(e){if(!e.status)console.error('Request failed:',e?.message);if(res.headersSent)return res.end();return json(e.status||500,{error:e.code||'SERVER',message:e.status?e.message:'Не удалось выполнить действие. Повторите попытку.'})}
  });
}
export async function loadConfig(){
  let file={};if(process.env.SMENA_CONFIG)file=JSON.parse((await readFile(process.env.SMENA_CONFIG,'utf8')).replace(/^\uFEFF/,''));
  return {...file,botToken:process.env.BOT_TOKEN||file.botToken,botUsername:process.env.BOT_USERNAME||file.botUsername,ownerId:Number(process.env.OWNER_TELEGRAM_ID||file.ownerId),publicUrl:process.env.PUBLIC_URL||file.publicUrl,port:Number(process.env.PORT||file.port||8732),trustProxy:process.env.TRUST_PROXY==='1'||file.trustProxy===true,yclients:{partnerToken:process.env.YCLIENTS_PARTNER_TOKEN||file.yclients?.partnerToken,userToken:process.env.YCLIENTS_USER_TOKEN||file.yclients?.userToken,companyId:process.env.YCLIENTS_COMPANY_ID||file.yclients?.companyId,staffId:process.env.YCLIENTS_STAFF_ID||file.yclients?.staffId},host:process.env.HOST||file.host||'127.0.0.1',dataDir:process.env.DATA_DIR||file.dataDir||resolve(ROOT,'data')};
}
async function main(){
  const config=await loadConfig();if(!config.botToken||!Number.isSafeInteger(config.ownerId)||config.ownerId<=0)throw Error('Set BOT_TOKEN and OWNER_TELEGRAM_ID, or SMENA_CONFIG.');
  await mkdir(config.dataDir,{recursive:true});const store=new Store(resolve(config.dataDir,'smena.sqlite'),config.ownerId);
  let bot=null;const sync=createSync({config,store,notify:text=>bot?bot.notify(text):Promise.resolve()});
  const server=createApp(config,store,sync);server.listen(config.port,config.host,()=>console.log(`Smena listening on port ${config.port}`));
  bot=config.publicUrl?startBot(config,store):null;
  const syncLoop=sync.start();
  const snap=()=>{try{store.snapshot(resolve(config.dataDir,'snapshots'))}catch(e){console.error('Snapshot failed:',e.message)}};snap();const snapTimer=setInterval(snap,6*3600*1000);snapTimer.unref();
  // Сбой в фоновой задаче не должен ронять сервер молча: пишем причину (без данных запроса) и работаем дальше.
  process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e?.message||e));
  const shutdown=()=>{bot?.stop();syncLoop.stop();clearInterval(snapTimer);server.close(()=>{store.close();process.exit(0)});server.closeIdleConnections?.()};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
