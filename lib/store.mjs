import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {initialState,AppError,active} from './core.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export class Store{
  constructor(path,ownerId){
    this.ownerId=Number(ownerId);this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access(id INTEGER PRIMARY KEY CHECK(id=1),user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent(key TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY,at TEXT NOT NULL,data TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO state VALUES(1,?,0)').run(JSON.stringify(initialState()));
  }
  read(){const r=this.db.prepare('SELECT * FROM state WHERE id=1').get();return {...initialState(),...JSON.parse(r.data),revision:r.revision}}
  mutate(expected,fn,action='Изменение данных'){
    this.db.exec('BEGIN IMMEDIATE');
    try{const before=this.read();if(!Number.isInteger(expected)||before.revision!==expected)throw new AppError('CONFLICT','Расписание изменилось. Данные обновлены; повторите действие.',409);
      const next=fn(structuredClone(before));next.revision=before.revision+1;
      this.db.prepare('UPDATE state SET data=?,revision=? WHERE id=1').run(JSON.stringify(next),next.revision);
      this.db.prepare('INSERT INTO audit(at,action) VALUES(?,?)').run(new Date().toISOString(),action);
      this.db.exec('DELETE FROM audit WHERE id<=(SELECT MAX(id) FROM audit)-1000');
      this.db.exec('COMMIT');return next;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }

  restore(expected,validated){
    return this.mutate(expected,before=>{
      this.db.prepare('INSERT INTO backups(at,data) VALUES(?,?)').run(new Date().toISOString(),JSON.stringify(before));
      this.db.exec('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 5)');
      return structuredClone(validated);
    },'Восстановление резервной копии');
  }
  backups(){
    return this.db.prepare('SELECT id,at,data FROM backups ORDER BY id DESC').all().map(r=>({id:r.id,at:r.at,records:JSON.parse(r.data).records.length}));
  }
  backup(id){
    const row=this.db.prepare('SELECT data FROM backups WHERE id=?').get(id);
    if(!row)throw new AppError('NOT_FOUND','Сохранённая копия не найдена.',404);
    return JSON.parse(row.data);
  }
  allowed(id){return Number(id)===this.ownerId||this.friend()===Number(id)}
  friend(){return this.db.prepare('SELECT user_id FROM access WHERE id=1').get()?.user_id??null}
  revokeFriend(){this.db.exec('DELETE FROM access; DELETE FROM invites');this.db.prepare('DELETE FROM sessions WHERE user_id<>?').run(this.ownerId)}
  createInvite(now=Math.floor(Date.now()/1000)){const code=randomBytes(24).toString('base64url');this.db.exec('DELETE FROM invites');this.db.prepare('INSERT INTO invites VALUES(?,?)').run(hash(code),now+86400);return code}
  redeemInvite(code,id,now=Math.floor(Date.now()/1000)){
    if(typeof code!=='string'||code.length>100||this.friend()!==null||!Number.isSafeInteger(id)||id<=0||id===this.ownerId)return false;
    this.db.exec('BEGIN IMMEDIATE');
    try{const invite=this.db.prepare('SELECT expires FROM invites WHERE hash=?').get(hash(code));if(!invite||invite.expires<=now){this.db.exec('ROLLBACK');return false}
      this.db.prepare('INSERT INTO access VALUES(1,?)').run(id);this.db.exec('DELETE FROM invites; COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  createSession(id,now=Math.floor(Date.now()/1000)){if(!this.allowed(id))throw new AppError('FORBIDDEN','Это личный кабинет. Доступ не выдан.',403);const token=randomBytes(32).toString('base64url');this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),id,now+28800);return token}
  sessionUser(token,now=Math.floor(Date.now()/1000)){if(typeof token!=='string'||token.length>100)return null;const s=this.db.prepare('SELECT user_id,expires FROM sessions WHERE hash=?').get(hash(token));return s&&s.expires>now&&this.allowed(s.user_id)?s.user_id:null}
  meta(key,value){if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,String(value));return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value}
  claim(key){const now=Math.floor(Date.now()/1000);this.db.prepare('DELETE FROM sent WHERE at<?').run(now-30*86400);return this.db.prepare('INSERT OR IGNORE INTO sent VALUES(?,?)').run(key,now).changes===1}
  unclaim(key){this.db.prepare('DELETE FROM sent WHERE key=?').run(key)}
  audit(){return this.db.prepare('SELECT at,action FROM audit ORDER BY id DESC LIMIT 20').all()}
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
        this.db.prepare('UPDATE state SET data=?,revision=? WHERE id=1').run(JSON.stringify(next),next.revision);
        this.db.prepare('INSERT INTO audit(at,action) VALUES(?,?)').run(new Date().toISOString(),'Синхронизация YCLIENTS');
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
