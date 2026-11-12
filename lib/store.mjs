import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {initialState,AppError,active} from './core.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export class Store{
  constructor(path,ownerId){
    // cabinet — чей кабинет читает и меняет этот экземпляр. По умолчанию владелец бота; scope(id) даёт кабинет другого мастера.
    this.ownerId=Number(ownerId);this.cabinet=this.ownerId;this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cabinets(id INTEGER PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members(cabinet INTEGER PRIMARY KEY,user_id INTEGER NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS accounts(user_id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent(key TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links(slug TEXT PRIMARY KEY,cabinet INTEGER NOT NULL UNIQUE);`);
    for(const table of ['invites','audit','backups'])if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='cabinet')){
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN cabinet INTEGER`);this.db.prepare(`UPDATE ${table} SET cabinet=?`).run(this.ownerId);
    }
    // База до 0.6 хранила один кабинет в таблицах state и access. Переносим его владельцу; старые таблицы не трогаем.
    const has=name=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(!this.db.prepare('SELECT 1 FROM cabinets WHERE id=?').get(this.ownerId)){
      const old=has('state')&&this.db.prepare('SELECT data,revision FROM state WHERE id=1').get();
      this.db.prepare('INSERT INTO cabinets VALUES(?,?,?)').run(this.ownerId,old?old.data:JSON.stringify(initialState()),old?old.revision:0);
      const friend=has('access')&&this.db.prepare('SELECT user_id FROM access WHERE id=1').get();
      if(friend)this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(this.ownerId,friend.user_id);
    }
  }
  scope(id){const s=Object.create(this);s.cabinet=Number(id);return s}
  // Ключи meta и sent владельца остаются без префикса — так их писали версии до 0.6.
  key(k){return this.cabinet===this.ownerId?k:'c'+this.cabinet+':'+k}
  read(){const r=this.db.prepare('SELECT * FROM cabinets WHERE id=?').get(this.cabinet);if(!r)throw new AppError('AUTH','Кабинет удалён. Откройте приложение заново.',401);const base=initialState(),data=JSON.parse(r.data);return {...base,...data,settings:{...base.settings,...data.settings},revision:r.revision}} // кабинет старой версии получает умолчания и для новых настроек
  mutate(expected,fn,action='Изменение данных'){
    this.db.exec('BEGIN IMMEDIATE');
    try{const before=this.read();if(!Number.isInteger(expected)||before.revision!==expected)throw new AppError('CONFLICT','Расписание изменилось. Данные обновлены; повторите действие.',409);
      const next=fn(structuredClone(before));next.revision=before.revision+1;
      this.db.prepare('UPDATE cabinets SET data=?,revision=? WHERE id=?').run(JSON.stringify(next),next.revision,this.cabinet);
      this.log(action);
      this.db.exec('COMMIT');return next;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }

  log(action){
    this.db.prepare('INSERT INTO audit(at,action,cabinet) VALUES(?,?,?)').run(new Date().toISOString(),action,this.cabinet);
    this.db.prepare('DELETE FROM audit WHERE cabinet=?1 AND id NOT IN (SELECT id FROM audit WHERE cabinet=?1 ORDER BY id DESC LIMIT 1000)').run(this.cabinet);
  }
  restore(expected,validated){
    return this.mutate(expected,before=>{
      this.db.prepare('INSERT INTO backups(at,data,cabinet) VALUES(?,?,?)').run(new Date().toISOString(),JSON.stringify(before),this.cabinet);
      this.db.prepare('DELETE FROM backups WHERE cabinet=?1 AND id NOT IN (SELECT id FROM backups WHERE cabinet=?1 ORDER BY id DESC LIMIT 5)').run(this.cabinet);
      return structuredClone(validated);
    },'Восстановление резервной копии');
  }
  backups(){
    return this.db.prepare('SELECT id,at,data FROM backups WHERE cabinet=? ORDER BY id DESC').all(this.cabinet).map(r=>({id:r.id,at:r.at,records:JSON.parse(r.data).records.length}));
  }
  backup(id){
    const row=this.db.prepare('SELECT data FROM backups WHERE id=? AND cabinet=?').get(id,this.cabinet);
    if(!row)throw new AppError('NOT_FOUND','Сохранённая копия не найдена.',404);
    return JSON.parse(row.data);
  }
  // Кабинет пользователя: свой (мастер) или тот, куда его пригласили. null — доступа нет.
  cabinetOf(id){
    id=Number(id);if(!Number.isSafeInteger(id)||id<=0)return null;
    if(this.db.prepare('SELECT 1 FROM cabinets WHERE id=?').get(id))return id;
    return this.db.prepare('SELECT cabinet FROM members WHERE user_id=?').get(id)?.cabinet??null;
  }
  allowed(id){return this.cabinetOf(id)!==null}
  cabinets(){return this.db.prepare('SELECT id FROM cabinets ORDER BY id').all().map(r=>r.id)}
  // Все, кому бот может писать: мастера и приглашённые.
  users(){return [...this.cabinets(),...this.db.prepare('SELECT user_id FROM members').all().map(r=>r.user_id)]}
  recipient(){return this.friend()||this.cabinet}
  createCabinet(id,state=initialState()){
    id=Number(id);if(!Number.isSafeInteger(id)||id<=0)throw new AppError('INVALID','Некорректный пользователь.');
    this.db.prepare('DELETE FROM members WHERE user_id=?').run(id); // свой кабинет заменяет гостевой доступ
    this.db.prepare('INSERT OR IGNORE INTO cabinets VALUES(?,?,0)').run(id,JSON.stringify(state));
    return this.scope(id);
  }
  deleteCabinet(){
    if(this.cabinet===this.ownerId)throw new AppError('FORBIDDEN','Кабинет владельца бота удалить нельзя.',403);
    const id=this.cabinet,friend=this.friend(),like='c'+id+':%';
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of ['invites','audit','backups'])this.db.prepare(`DELETE FROM ${table} WHERE cabinet=?`).run(id);
      this.db.prepare('DELETE FROM members WHERE cabinet=?').run(id);this.db.prepare('DELETE FROM links WHERE cabinet=?').run(id);this.db.prepare('DELETE FROM accounts WHERE user_id=?').run(id);
      this.db.prepare('DELETE FROM meta WHERE key LIKE ?').run(like);this.db.prepare('DELETE FROM sent WHERE key LIKE ?').run(like);
      this.db.prepare('DELETE FROM sessions WHERE user_id IN (?,?)').run(id,friend??id);this.db.prepare('DELETE FROM cabinets WHERE id=?').run(id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  // Подключение YCLIENTS мастера: зашифрованный токен, филиал, сотрудник. Шифрует и расшифровывает вызывающий код.
  account(value){
    if(value===null)this.db.prepare('DELETE FROM accounts WHERE user_id=?').run(this.cabinet);
    else if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO accounts VALUES(?,?)').run(this.cabinet,JSON.stringify(value));
    const row=this.db.prepare('SELECT data FROM accounts WHERE user_id=?').get(this.cabinet);return row?JSON.parse(row.data):null;
  }
  // Публичная ссылка онлайн-записи. Короткая и случайная: по ней нельзя угадать чужой кабинет. reset — выпустить новую, старая перестаёт работать.
  bookingSlug(reset=false){
    if(reset)this.db.prepare('DELETE FROM links WHERE cabinet=?').run(this.cabinet);
    const row=this.db.prepare('SELECT slug FROM links WHERE cabinet=?').get(this.cabinet);if(row)return row.slug;
    const slug=randomBytes(9).toString('base64url');this.db.prepare('INSERT INTO links VALUES(?,?)').run(slug,this.cabinet);return slug;
  }
  cabinetBySlug(slug){return typeof slug==='string'&&/^[A-Za-z0-9_-]{12}$/.test(slug)?this.db.prepare('SELECT cabinet FROM links WHERE slug=?').get(slug)?.cabinet??null:null}
  friend(){return this.db.prepare('SELECT user_id FROM members WHERE cabinet=?').get(this.cabinet)?.user_id??null}
  revokeFriend(){
    const friend=this.friend();
    this.db.prepare('DELETE FROM members WHERE cabinet=?').run(this.cabinet);this.db.prepare('DELETE FROM invites WHERE cabinet=?').run(this.cabinet);
    if(friend!==null)this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(friend);
  }
  createInvite(now=Math.floor(Date.now()/1000)){const code=randomBytes(24).toString('base64url');this.db.prepare('DELETE FROM invites WHERE cabinet=?').run(this.cabinet);this.db.prepare('INSERT INTO invites(hash,expires,cabinet) VALUES(?,?,?)').run(hash(code),now+86400,this.cabinet);return code}
  // Приглашение само знает свой кабинет; принять его может только тот, у кого ещё нет доступа никуда.
  redeemInvite(code,id,now=Math.floor(Date.now()/1000)){
    if(typeof code!=='string'||code.length>100||!Number.isSafeInteger(id)||id<=0||this.allowed(id))return false;
    this.db.exec('BEGIN IMMEDIATE');
    try{const invite=this.db.prepare('SELECT expires,cabinet FROM invites WHERE hash=?').get(hash(code));
      if(!invite||invite.expires<=now||this.db.prepare('SELECT 1 FROM members WHERE cabinet=?').get(invite.cabinet)){this.db.exec('ROLLBACK');return false}
      this.db.prepare('INSERT INTO members VALUES(?,?)').run(invite.cabinet,id);this.db.prepare('DELETE FROM invites WHERE cabinet=?').run(invite.cabinet);this.db.exec('COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  createSession(id,now=Math.floor(Date.now()/1000)){if(!this.allowed(id))throw new AppError('FORBIDDEN','Это личный кабинет. Доступ не выдан.',403);const token=randomBytes(32).toString('base64url');this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),id,now+28800);return token}
  sessionUser(token,now=Math.floor(Date.now()/1000)){if(typeof token!=='string'||token.length>100)return null;const s=this.db.prepare('SELECT user_id,expires FROM sessions WHERE hash=?').get(hash(token));return s&&s.expires>now&&this.allowed(s.user_id)?s.user_id:null}
  meta(key,value){key=this.key(key);if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,String(value));return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value}
  claim(key){const now=Math.floor(Date.now()/1000);this.db.prepare('DELETE FROM sent WHERE at<?').run(now-30*86400);return this.db.prepare('INSERT OR IGNORE INTO sent VALUES(?,?)').run(this.key(key),now).changes===1}
  unclaim(key){this.db.prepare('DELETE FROM sent WHERE key=?').run(this.key(key))}
  audit(){return this.db.prepare('SELECT at,action FROM audit WHERE cabinet=? ORDER BY id DESC LIMIT 20').all(this.cabinet)}
  // Заменяет записи YCLIENTS в окне дат (или все, если окна нет). Локальные записи не трогает.
  applySync(incoming,window){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const before=this.read(),inWindow=r=>!window||r.date>=window.from&&r.date<=window.to;
      const prev=new Map(before.records.filter(r=>r.source==='yclients'&&inWindow(r)).map(r=>[r.externalId,r]));
      const fresh=new Map(incoming.map(r=>[r.externalId,r]));
      const strip=({updatedAt,...r})=>JSON.stringify(r);
      const merged=[...fresh.values()].map(r=>{const p=prev.get(r.externalId);return p&&strip(p)===strip({...r,id:p.id})?p:{...r,id:p?.id||r.id,updatedAt:new Date().toISOString()}});
      const added=merged.filter(r=>!prev.has(r.externalId));
      const removed=[...prev.values()].filter(p=>active(p)&&(!fresh.has(p.externalId)||!active(fresh.get(p.externalId))));
      const changed=merged.length!==prev.size||merged.some(r=>r!==prev.get(r.externalId));
      const records=before.records.filter(r=>r.source!=='yclients'||!inWindow(r)).concat(merged);
      if(changed){
        // Версию не повышаем: открытые формы не должны получать конфликт из-за фоновой синхронизации.
        // Пересечения с записями YCLIENTS всё равно проверяются на сервере при сохранении.
        const next={...before,records};
        this.db.prepare('UPDATE cabinets SET data=?,revision=? WHERE id=?').run(JSON.stringify(next),next.revision,this.cabinet);
        this.log('Синхронизация YCLIENTS');
      }
      this.db.exec('COMMIT');
      return {changed,added,removed,count:records.filter(r=>r.source==='yclients').length};
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  // Ежедневная копия базы целиком (VACUUM INTO), хранится `keep` последних.
  snapshot(dir,keep=14,today=new Date().toISOString().slice(0,10)){
    mkdirSync(dir,{recursive:true});
    const file=join(dir,`smena-${today}.sqlite`);
    if(!existsSync(file))this.db.exec(`VACUUM INTO '${file.replaceAll("'","''")}'`);
    const old=readdirSync(dir).filter(f=>/^smena-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0,-keep);
    for(const f of old)rmSync(join(dir,f),{force:true});
    return file;
  }
  close(){this.db.close()}
}
