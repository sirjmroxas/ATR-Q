import { env } from 'cloudflare:workers';
import { migrateDemoNames, applyAction, demoSession, emptySession, type Action, type Session } from '../../../lib/engine';
import {globalStandings, type StandingsCutoffs} from '../../../lib/global-standings';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(JSON.parse(JSON.stringify(data,(key,value)=>key==='checkInKey'?undefined:value)),{status,headers:{'Cache-Control':'no-store'}});
const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const pinHash=async(pin:string,salt:string)=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);const result=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return Array.from(new Uint8Array(result)).map(b=>b.toString(16).padStart(2,'0')).join('');};
function safeEqual(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
type Row={owner:string;id:string;payload:string;revision:number;pin_hash:string;pin_salt:string};
async function rateLimit(db:D1Database,key:string,limit:number){const now=Date.now();await db.prepare('INSERT INTO login_attempts (id,count,reset_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN ? ELSE reset_at END').bind(key,now+15*60000,now,now,now+15*60000).run();const r=await db.prepare('SELECT count FROM login_attempts WHERE id=?').bind(key).first<{count:number}>();return (r?.count||0)<=limit;}
async function issueToken(db:D1Database,id:string){const token=crypto.randomUUID()+crypto.randomUUID();await db.prepare('INSERT INTO admin_tokens (hash,session_id,expires_at) VALUES (?,?,?)').bind(await digest(token),id,Date.now()+12*3600000).run();return token;}
async function standingsRoot(db:D1Database, row:Row) {
 const state=JSON.parse(row.payload) as Session;
 const rootId=state.globalStandingsRoot??row.id;
 const root=await db.prepare('SELECT id,owner,payload,revision FROM sessions WHERE id=? AND owner=?').bind(rootId,row.owner).first<Row>();
 if(!root)throw Error('The global standings group could not be found.');
 return root;
}
async function readGlobalStandings(db:D1Database,row:Row){
 const root=await standingsRoot(db,row);
 const group=await db.prepare('SELECT payload FROM sessions WHERE owner=?').bind(row.owner).all<{payload:string}>();
 return globalStandings(group.results.flatMap(item=>{const state=JSON.parse(item.payload) as Session;return [...(state.globalArchives??[]),state];}),JSON.parse(root.payload).globalStandingsCutoffs);
}
export async function GET(request:Request){
 try{
  const url=new URL(request.url),id=url.searchParams.get('id');
  if(!id||!/^[a-f0-9-]{36}$/.test(id))return json({error:'Session not found.'},404);
  if(!env.DB)return json({error:'Live sessions are temporarily unavailable.'},503);
  const row=await env.DB.prepare('SELECT id,owner,payload,revision FROM sessions WHERE id=?').bind(id).first<Row>();
  if(!row)return json({error:'This session link is unavailable. Check the link with your organizer.'},404);
  if(url.searchParams.get('standings')==='global')return json({rows:await readGlobalStandings(env.DB,row)});
  return json({session:migrateDemoNames(JSON.parse(row.payload)),serverTime:Date.now()});
 }catch{return json({error:'Unable to load the live session.'},503);}
}
export async function POST(request:Request){
 try{
  if(!env.DB)return json({error:'Live sessions are temporarily unavailable.'},503);const db=env.DB;
  if(new URL(request.url).origin!==new URL(request.headers.get('origin')||request.url).origin)return json({error:'Request origin is not allowed.'},403);
  const text=await request.text();if(text.length>450000)return json({error:'Request is too large.'},413);const body=JSON.parse(text);const ip=request.headers.get('cf-connecting-ip')||'local';
  if(body.type==='create'){
   let owner='guest:'+crypto.randomUUID(),rootId:string|undefined;
   if(body.previousSessionId){
    const previous=await db.prepare('SELECT id,owner,payload,revision,pin_hash,pin_salt FROM sessions WHERE id=?').bind(String(body.previousSessionId)).first<Row>();
    if(!previous)return json({error:'Previous session not found. Paste its session link.'},404);
    const token=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';
    const auth=await db.prepare('SELECT hash FROM admin_tokens WHERE hash=? AND session_id=? AND expires_at>?').bind(await digest(token),previous.id,Date.now()).first();
    if(!auth){
     if(!await rateLimit(db,'login:'+await digest(ip+':'+previous.id),8))return json({error:'Too many PIN attempts. Try again in 15 minutes.'},429);
     if(!/^\d{4}$/.test(body.previousPin||'')||!safeEqual(await pinHash(body.previousPin,previous.pin_salt),previous.pin_hash))return json({error:'Enter the organizer PIN for the previous session.'},400);
    }
    const root=await standingsRoot(db,previous);owner=previous.owner;rootId=root.id;
   }
   if(!/^\d{4}$/.test(body.pin||''))return json({error:'Choose a four-digit organizer PIN.'},400);
   if(!await rateLimit(db,'create:'+await digest(ip),10))return json({error:'Too many sessions created. Please try again in 15 minutes.'},429);
   let s=body.withDemo?demoSession():emptySession();if(body.branding)s=applyAction(s,{...body.branding,type:'settings',title:body.title});if(body.matching){const m=body.matching;s=applyAction(s,{type:'queueSettings',queueMode:'atr',showStandings:m.showStandings,selfCheckin:m.selfCheckin,capacityLimit:m.capacityLimit});if(s.queueMode==='clubs'&&body.withDemo)s=applyAction(s,{type:'demo'});}s.id=crypto.randomUUID();if(body.title)s.title=String(body.title).trim().slice(0,80)||s.title;
   s.globalStandingsRoot=rootId??s.id;
   const salt=crypto.randomUUID();await db.prepare('INSERT INTO sessions (id,owner,payload,revision,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?,?)').bind(s.id,owner,JSON.stringify(s),s.revision,await pinHash(body.pin,salt),salt,Date.now()).run();return json({session:s,token:await issueToken(db,s.id),serverTime:Date.now()});
  }
  const id=String(body.id||'');const row=await db.prepare('SELECT id,owner,payload,revision,pin_hash,pin_salt FROM sessions WHERE id=?').bind(id).first<Row>();if(!row)return json({error:'Session not found.'},404);
  if(body.type==='login'){
   const key='login:'+await digest(ip+':'+id);if(!await rateLimit(db,key,8))return json({error:'Too many PIN attempts. Try again in 15 minutes.'},429);
   if(!/^\d{4}$/.test(body.pin||'')||!safeEqual(await pinHash(body.pin,row.pin_salt),row.pin_hash))return json({error:'That PIN is incorrect.'},401);
   await db.prepare('DELETE FROM login_attempts WHERE id=?').bind(key).run();return json({token:await issueToken(db,id)});
  }
  if(body.type==='selfCheckin'){
   if(!await rateLimit(db,'checkin:'+await digest(ip+':'+id),30))return json({error:'Too many check-in attempts. Try again in 15 minutes.'},429);
   for(let attempt=0;attempt<3;attempt++){
    const current=attempt?await db.prepare('SELECT payload,revision FROM sessions WHERE id=?').bind(id).first<Row>():row;
    if(!current)return json({error:'Session not found.'},404);
    const state=JSON.parse(current.payload);
    const next=applyAction(state,{type:'selfCheckin',name:body.name,skill:body.skill,photo:body.photo,checkInKey:body.checkInKey,division:body.division,side:body.side});
    if(next===state)return json({session:next,serverTime:Date.now()});
    const changed=await db.prepare('UPDATE sessions SET payload=?,revision=? WHERE id=? AND revision=?').bind(JSON.stringify(next),next.revision,id,current.revision).run();
    if(changed.meta.changes)return json({session:next,serverTime:Date.now()});
   }
   return json({error:'Other players are checking in. Please submit again.'},409);
  }
  const token=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';const auth=await db.prepare('SELECT hash FROM admin_tokens WHERE hash=? AND session_id=? AND expires_at>?').bind(await digest(token),id,Date.now()).first();if(!auth)return json({error:'Unlock organizer controls to make this change.'},401);
  if(body.type==='deleteGlobalPlayer'||body.type==='resetGlobalStandings'){
   const key=String(body.playerKey??'');
   if(body.type==='deleteGlobalPlayer'&&(!key.startsWith('p:')||key.length>140))return json({error:'Choose a player record.'},400);
   const deletedAt=Date.now();
   for(let attempt=0;attempt<3;attempt++){
    const root=await standingsRoot(db,row),state=JSON.parse(root.payload) as Session;
    const cutoffs:StandingsCutoffs={...state.globalStandingsCutoffs};
    if(body.type==='resetGlobalStandings'){cutoffs.resetAt=deletedAt;cutoffs.players={};}
    else cutoffs.players={...cutoffs.players,[key]:deletedAt};
    state.globalStandingsCutoffs=cutoffs;state.revision++;state.updatedAt=deletedAt;
    const result=await db.prepare('UPDATE sessions SET payload=?,revision=? WHERE id=? AND revision=?').bind(JSON.stringify(state),state.revision,root.id,root.revision).run();
    if(result.meta.changes)return json({rows:await readGlobalStandings(db,row)});
   }
   return json({error:'The records changed. Please try again.'},409);
  }
  if(body.type==='logout'){await db.prepare('DELETE FROM admin_tokens WHERE hash=?').bind(await digest(token)).run();return json({ok:true});}
  if(body.type==='changePin'){
   if(!/^\d{4}$/.test(body.pin||''))return json({error:'Choose a four-digit PIN.'},400);const salt=crypto.randomUUID();await db.prepare('UPDATE sessions SET pin_hash=?,pin_salt=? WHERE id=?').bind(await pinHash(body.pin,salt),salt,id).run();await db.prepare('DELETE FROM admin_tokens WHERE session_id=?').bind(id).run();return json({token:await issueToken(db,id)});
  }
  if(body.type!=='mutate')return json({error:'Unknown request.'},400);
  if(body.revision!==row.revision)return json({error:'Another organizer changed the session. The board has refreshed; try again.'},409);
  const s=applyAction(JSON.parse(row.payload),body.action as Action);const updated=await db.prepare('UPDATE sessions SET payload=?,revision=? WHERE id=? AND revision=?').bind(JSON.stringify(s),s.revision,id,row.revision).run();if(!updated.meta.changes)return json({error:'Session changed. Refresh and try again.'},409);return json({session:s,serverTime:Date.now()});
 }catch(error){return json({error:error instanceof Error&&!(error.message.includes('D1')||error.message.includes('SQL'))?error.message:'The session could not be updated. Please try again.'},400);}
}
