// Вход мастера через его аккаунт YCLIENTS и справочники для выбора филиала.
// Сверено с developers.yclients.com: POST /api/v1/auth (логин, пароль, при 2FA — объект "2fa" с uuid и кодом),
// GET /api/v1/companies?my=1, GET /api/v1/company/{id}/staff. Заголовок: "Bearer <partner>[, User <user>]".
// Пароль проходит через сервер транзитом: не сохраняется и не пишется в журнал. Хранится только токен, и тот зашифрован.
import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {AppError} from './core.mjs';

export const YCLIENTS_API='https://api.yclients.com';
// Восстановление пароля у YCLIENTS — на странице входа («Не помню пароль»), отдельного адреса и метода API нет.
export const RECOVERY_URL='https://yclients.com/signin';

// AES-256-GCM, ключ выводится из секрета сервера: копия базы без конфигурации токенов не раскрывает.
export function tokenBox(secret){
  const key=Buffer.from(hkdfSync('sha256',String(secret),'','smena-yclients-token',32));
  return {
    seal(text){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(String(text),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64url')},
    open(box){
      try{const raw=Buffer.from(String(box),'base64url'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));return Buffer.concat([d.update(raw.subarray(28)),d.final()]).toString('utf8')}
      catch{return null}
    }
  };
}

const text=(v,max=120)=>typeof v==='string'?v.trim().slice(0,max):'';
export function createYclients({partnerToken,apiUrl=YCLIENTS_API,fetchImpl=fetch}={}){
  const enabled=!!partnerToken;
  async function call(path,{method='GET',body,userToken}={}){
    if(!enabled)throw new AppError('YC_OFF','Вход через YCLIENTS на этом сервере не настроен.',503);
    let response,data;
    try{
      response=await fetchImpl(apiUrl+'/api/v1/'+path,{method,headers:{Accept:'application/vnd.yclients.v2+json','Content-Type':'application/json',Authorization:`Bearer ${partnerToken}`+(userToken?`, User ${userToken}`:'')},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      data=await response.json().catch(()=>null);
    }catch{throw new AppError('YC_DOWN','YCLIENTS не отвечает. Попробуйте через минуту.',502)}
    if(response.ok&&data&&data.success!==false)return {status:response.status,data:data.data??data};
    const detail=text(data?.meta?.message||data?.message,150);
    if(response.status===429)throw new AppError('YC_RATE','YCLIENTS просит подождать. Повторите через минуту.',429);
    if(response.status===401&&userToken)throw new AppError('YC_EXPIRED','YCLIENTS больше не принимает этот вход. Войдите заново.',400);
    if(response.status>=500)throw new AppError('YC_DOWN','YCLIENTS временно недоступен. Попробуйте через минуту.',502);
    throw new AppError('YC_REJECTED',detail||'YCLIENTS отклонил запрос.',400);
  }
  return {
    enabled,
    // Возвращает {user:{id,name,token}} либо {need2fa:{uuid,recipient,attemptsLeft}}, если YCLIENTS выслал код подтверждения.
    async login(login,password,twofa=null){
      let result;
      try{result=await call('auth',{method:'POST',body:{login,password,...(twofa?{'2fa':{uuid:twofa.uuid,secret:twofa.code}}:{})}})}
      catch(e){if(e.code==='YC_REJECTED'&&!twofa&&!/код|code|2fa/i.test(e.message))throw new AppError('YC_LOGIN',/логин|парол|найден|login|password/i.test(e.message)?e.message:'Неверный логин или пароль.',400);throw e}
      const d=result.data||{};
      if(d.user_token)return {user:{id:Number(d.id),name:text(d.name,80),token:String(d.user_token)}};
      if(d.uuid)return {need2fa:{uuid:String(d.uuid).slice(0,100),recipient:text(d.transport?.recipient,100),attemptsLeft:Number.isFinite(Number(d.attempts_left))?Number(d.attempts_left):null}};
      throw new AppError('YC_REJECTED','YCLIENTS ответил неожиданно. Попробуйте ещё раз.',502);
    },
    async companies(userToken){
      const {data}=await call('companies?my=1&count=100',{userToken});
      return (Array.isArray(data)?data:[]).filter(c=>c&&c.id!=null).slice(0,100).map(c=>({id:Number(c.id),title:text(c.title||c.public_title,100)||'Филиал',address:text(c.address,160),timeZone:text(c.timezone_name,60)}));
    },
    // Услуги мастера: длительность — его собственная (seance_length при фильтре по сотруднику), цена — минимальная.
    async services(userToken,companyId,staffId){
      const {data}=await call(`company/${encodeURIComponent(companyId)}/services?staff_id=${encodeURIComponent(staffId)}`,{userToken});
      const seen=new Set(),out=[];
      for(const s of Array.isArray(data)?data:[]){
        const name=text(s?.title,80);if(!name||seen.has(name))continue;
        const own=Array.isArray(s.staff)?s.staff.find(x=>Number(x?.id)===Number(staffId))?.seance_length:null;
        const seconds=Number(s.seance_length||own||s.duration||3600),minutes=Math.min(480,Math.max(15,Math.round(seconds/60/15)*15));
        const price=Math.max(0,Math.min(1000000,Math.round(Number(s.price_min)||0)));
        seen.add(name);out.push({name,duration:minutes,price});if(out.length===20)break;
      }
      return out;
    },
    async staff(userToken,companyId){
      const {data}=await call(`company/${encodeURIComponent(companyId)}/staff`,{userToken});
      return (Array.isArray(data)?data:[]).filter(s=>s&&s.id!=null&&!s.fired&&!s.is_deleted).slice(0,300).map(s=>({id:Number(s.id),name:text(s.name,80)||'Мастер',role:text(s.specialization,80),userId:Number(s.user_id)||0}));
    }
  };
}
