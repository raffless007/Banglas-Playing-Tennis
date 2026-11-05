// Opt-in local Docker/PostgREST integration: never point this suite at production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import * as crypto from 'node:crypto';
import '../public/js/score-format.js';

const enabled=process.env.BPT_LOCAL_DOCKER_TEST==='1';
const container='supabase_db_bpt-watch-shortcuts', workdir='/private/tmp/bpt-watch-db-validation';
const event='a0000000-0000-4000-8000-000000000001';
const ids=Array.from({length:6},(_,i)=>`a0000000-0000-4000-8000-00000000000${i+2}`);
const secret='synthetic-local-integration-session-secret';
function sql(query){return execFileSync('docker',['exec','-i',container,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:query,encoding:'utf8'}).trim()}
function token(type,id,expired=false,sid=null){const payload=Buffer.from(JSON.stringify({type,...(type==='player'?{sub:id}:{}),...(sid?{sid}:{}),iat:Date.now()-1000,exp:Date.now()+(expired?-1000:3600000)})).toString('base64url');return `${payload}.${crypto.createHmac('sha256',secret).update(payload).digest('base64url')}`}
function settings(){
  let output;try{output=execFileSync('npm',['exec','--offline','--package=supabase','--','supabase','status','-o','env'],{cwd:workdir,encoding:'utf8',env:{...process.env,HOME:'/private/tmp',DOCKER_HOST:'unix:///Users/RafeedSiddiquey/.docker/run/docker.sock',npm_config_cache:'/private/tmp/bpt-watch-npm-cache'},stdio:['ignore','pipe','ignore']})}catch{throw new Error('Unable to obtain isolated local Supabase settings')}
  const values=Object.fromEntries(output.trim().split('\n').filter(x=>x.includes('=')).map(line=>{const p=line.indexOf('=');return [line.slice(0,p),line.slice(p+1).replace(/^"|"$/g,'')]}));
  if(!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(values.API_URL||''))throw new Error('Refusing non-local API target');
  if(!values.SERVICE_ROLE_KEY)throw new Error('Local service key unavailable');
  return values;
}
function oldPhoneHandler(source, config, notifications, metrics={requests:0}){
  const code=source.replace(/^import[\s\S]*?;\n/gm,'').replace(/^export \{[^}]*\};/gm,'').replace('export default async (req, context = {}) =>','return async (req, context = {}) =>');
  const createClient=()=>({});
  const trackedFetch=async(...args)=>{metrics.requests++;if(metrics.beforeFetch)await metrics.beforeFetch(...args);return fetch(...args)};
  return new Function('deps',`const {createHash,createHmac,pbkdf2Sync,randomBytes,randomUUID,timingSafeEqual,fetch,process,activePlayerIds,notifyPlayers,RAFEED_PLAYER_ID,createClient}=deps;\n${code}`)({...crypto,fetch:trackedFetch,createClient,activePlayerIds:async()=>[],notifyPlayers:async payload=>{notifications.push(payload);return {sent:0}},RAFEED_PLAYER_ID:ids[0],process:{env:{SUPABASE_URL:config.API_URL,SUPABASE_SERVICE_ROLE_KEY:config.SERVICE_ROLE_KEY,ADMIN_SESSION_SECRET:secret}}});
}
function median(values){const sorted=[...values].sort((a,b)=>a-b);return Math.round(sorted[Math.floor(sorted.length/2)]*10)/10}
const cases=[
 ['doubles',4,4,0,false,0,0,5],['doubles',4,4,1,false,0,0,5],['doubles',4,4,2,false,0,0,5],
 ['doubles',4,4,3,true,5,3,5],['doubles',4,4,3,true,7,5,7],['singles',4,4,2,false,0,0,5],
 ['singles',2,2,0,false,0,0,5],['singles',2,3,1,false,0,0,5],['singles',2,2,2,true,5,3,5],['singles',2,2,2,true,7,5,7]
];
const comparable=['event_id','match_type','games_to_win','tiebreak_to_win','team_a_player_ids','team_b_player_ids','games_a','games_b','tiebreak_a','tiebreak_b','points_a','points_b','submitted_by','started_at'];

test('old phone endpoint and atomic RPC persist equivalent synthetic results', {skip:!enabled,timeout:120000}, async()=>{
  const config=settings(), notifications=[], metrics={requests:0}, times=[], trips=[], source=execFileSync('git',['show','10aecc1316ca51de67c10103de2b553b9060215a:netlify/functions/api.mjs'],{encoding:'utf8'}), handler=oldPhoneHandler(source,config,notifications,metrics);
  const cleanup=`delete from public.match_scores where event_id='${event}'; delete from public.live_matches where event_id='${event}'; delete from public.events where id='${event}'; delete from public.players where id in (${ids.map(x=>`'${x}'`).join(',')});`;
  try {
    sql(`${cleanup} insert into public.players(id,name) values ${ids.map((x,i)=>`('${x}','Synthetic comparison ${i}')`).join(',')}; insert into public.events(id,event_date,start_time,end_time) values ('${event}',(now() at time zone 'Australia/Sydney')::date,'00:00','23:59'); insert into public.eois(event_id,player_id,status) select '${event}',id,'yes' from public.players where id in (${ids.slice(0,5).map(x=>`'${x}'`).join(',')});`);
    for(let i=0;i<cases.length+2;i++){
      const [fmt,target,ga,gb,tie,ta,tb,tieTarget]=cases[i%cases.length];
      const actor=i===cases.length?ids[4]:i===cases.length+1?ids[5]:ids[0], mode=i===cases.length+1?'admin':'player';
      const a=fmt==='doubles'?ids.slice(0,2):ids.slice(0,1), b=fmt==='doubles'?ids.slice(2,4):ids.slice(2,3);
      const phone=crypto.randomUUID(), atomic=crypto.randomUUID();
      const teams=x=>`array[${x.map(v=>`'${v}'`).join(',')}]::uuid[]`;
      const elapsed=[1,600,86400][i%3];
      sql(`insert into public.live_matches(id,event_id,match_type,games_to_win,tiebreak_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,is_tiebreak,tiebreak_a,tiebreak_b,points_a,points_b,completed,version,started_at,point_history) select id,'${event}','${fmt}',${target},${tieTarget},${teams(a)},${teams(b)},'${ids[0]}',${ga},${gb},${tie},${ta},${tb},24,18,true,7,date_trunc('second',now())-interval '${elapsed} seconds','[{"games_a":0}]'::jsonb from unnest(array['${phone}','${atomic}']::uuid[]) id;`);
      const headers={'content-type':'application/json',...(mode==='admin'?{authorization:`Bearer ${token('admin')}`}:{'x-player-session':token('player',actor)})};
      const tasks=[],before=metrics.requests,started=performance.now();const response=await handler(new Request('https://synthetic.invalid/?action=live-finish',{method:'POST',headers,body:JSON.stringify({matchId:phone,playerId:actor})}),{waitUntil:p=>tasks.push(p)});times.push(performance.now()-started);trips.push(metrics.requests-before);
      assert.equal(response.status,200,`phone case ${i}`);const phoneResult=await response.json();await Promise.all(tasks);
      const rpc=JSON.parse(sql(`select public.finalize_live_match_atomic('${atomic}',7,'${actor}','${mode}');`));assert.equal(rpc.status,'saved',`RPC case ${i}`);
      const actual=JSON.parse(sql(`select row_to_json(s) from public.match_scores s where id='${phoneResult.score.id}';`));
      const saved=JSON.parse(sql(`select row_to_json(s) from public.match_scores s where source_live_match_id='${atomic}';`));
      for(const field of comparable)assert.deepEqual(saved[field],actual[field],`case ${i}: ${field}`);
      assert.ok(Math.abs(Date.parse(saved.ended_at)-Date.parse(actual.ended_at))<5000,`case ${i}: ended_at`);
      assert.ok(Math.abs(saved.duration_seconds-actual.duration_seconds)<=5,`case ${i}: duration`);
      assert.equal(saved.source_live_match_id,atomic);assert.equal(saved.live_match_id,null);
    }
    assert.equal(notifications.length,cases.length+2);
    console.log(`LOCAL_BASELINE median_ms=${median(times)} median_db_requests=${median(trips)} samples=${times.length}`);
  } finally {sql(cleanup)}
});

test('integrated phone API enforces version, authorization, retry and notifications on local Postgres', {skip:!enabled,timeout:120000}, async()=>{
  const config=settings(), notifications=[],metrics={requests:0}, times=[],trips=[], source=await readFile(new URL('../netlify/functions/api.mjs',import.meta.url),'utf8'),handler=oldPhoneHandler(source,config,notifications,metrics);
  const cleanup=`delete from public.match_scores where event_id='${event}'; delete from public.live_matches where event_id='${event}'; delete from public.events where id='${event}'; delete from public.players where id in (${ids.map(x=>`'${x}'`).join(',')});`;
  const tasks=[];
  async function call(action,body,actor=ids[0],admin=false,invalid=false){
    const headers={'content-type':'application/json',...(admin?{authorization:`Bearer ${token('admin')}`}:{'x-player-session':invalid==='expired'?token('player',actor,true):invalid?'invalid':token('player',actor)})};
    const before=metrics.requests,started=performance.now(),response=await handler(new Request(`https://synthetic.invalid/?action=${action}`,{method:'POST',headers,body:JSON.stringify({...body,playerId:actor})}),{waitUntil:p=>tasks.push(p)}),elapsed=performance.now()-started;
    await Promise.all(tasks.splice(0));const result=await response.json();if(action==='live-finish'&&response.status===200&&!result.alreadySaved){times.push(elapsed);trips.push(metrics.requests-before)}return {status:response.status,body:result};
  }
  function live({format='doubles',target=4,ga=4,gb=2,tie=false,ta=0,tb=0,complete=true,pending=false}={}){
    const id=crypto.randomUUID(),a=format==='singles'?ids.slice(0,1):ids.slice(0,2),b=format==='singles'?ids.slice(2,3):ids.slice(2,4),arr=x=>`array[${x.map(v=>`'${v}'`).join(',')}]::uuid[]`;
    sql(`insert into public.live_matches(id,event_id,match_type,games_to_win,tiebreak_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,is_tiebreak,tiebreak_a,tiebreak_b,points_a,points_b,completed,needs_tiebreak_choice,version,started_at) values ('${id}','${event}','${format}',${target},${tie&&ta>=7?7:5},${arr(a)},${arr(b)},'${ids[0]}',${ga},${gb},${tie},${ta},${tb},24,18,${complete},${pending},7,now()-interval '10 minutes');`);return id;
  }
  try{
    sql(`${cleanup} insert into public.players(id,name) values ${ids.map((x,i)=>`('${x}','Synthetic API ${i}')`).join(',')}; insert into public.events(id,event_date,start_time,end_time) values ('${event}',(now() at time zone 'Australia/Sydney')::date,'00:00','23:59'); insert into public.eois(event_id,player_id,status) select '${event}',id,'yes' from public.players where id in (${ids.slice(0,5).map(x=>`'${x}'`).join(',')});`);
    const id=live();
    assert.equal((await call('live-finish',{matchId:id})).status,400);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:'7'})).status,400);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:7},ids[0],false,true)).status,401);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:7},ids[0],false,'expired')).status,401);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:7,callerMode:'admin'},ids[5])).status,403);
    sql(`update public.eois set waitlist_position=1 where event_id='${event}' and player_id='${ids[4]}';`);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:7},ids[4])).status,403);
    sql(`update public.eois set waitlist_position=null where event_id='${event}' and player_id='${ids[4]}';`);
    const stale=await call('live-finish',{matchId:id,expectedVersion:6});assert.equal(stale.status,409);assert.equal(stale.body.conflict,true);
    assert.equal(sql(`select count(*) from public.match_scores where source_live_match_id='${id}';`),'0');
    assert.equal(notifications.length,0);
    const saved=await call('live-finish',{matchId:id,expectedVersion:7},ids[4]);assert.equal(saved.status,200);assert.equal(saved.body.score.submitted_by,ids[4]);
    assert.equal(sql(`select count(*) from public.live_matches where id='${id}';`),'0');assert.equal(notifications.length,1);
    const again=await call('live-finish',{matchId:id,expectedVersion:7},ids[4]);assert.equal(again.status,200);assert.equal(again.body.alreadySaved,true);assert.equal(notifications.length,1);
    assert.equal((await call('live-finish',{matchId:id,expectedVersion:7},ids[5])).status,403);
    assert.equal(sql(`select count(*) from public.match_scores where source_live_match_id='${id}';`),'1');
    const adminMatch=live();assert.equal((await call('live-finish',{matchId:adminMatch,expectedVersion:7},ids[5],true)).status,200);
    const incomplete=live({complete:false,ga:2,gb:1});
    const stalePoint=await call('live-point',{matchId:incomplete,winner:'a',actionId:crypto.randomUUID(),expectedVersion:6});assert.equal(stalePoint.status,409);assert.equal(stalePoint.body.conflict,true);
    assert.equal(sql(`select version from public.live_matches where id='${incomplete}';`),'7');
    const actionId=crypto.randomUUID(),firstPoint=await call('live-point',{matchId:incomplete,winner:'a',actionId,expectedVersion:7});assert.equal(firstPoint.status,200);
    const duplicatePoint=await call('live-point',{matchId:incomplete,winner:'a',actionId,expectedVersion:7});assert.equal(duplicatePoint.status,200);
    assert.equal(sql(`select version from public.live_matches where id='${incomplete}';`),'8');
    assert.equal((await call('live-point',{matchId:incomplete,winner:'b',actionId,expectedVersion:7})).status,409);
    assert.equal((await call('live-finish',{matchId:incomplete,expectedVersion:7})).status,409);sql(`delete from public.live_matches where id='${incomplete}';`);
    const pending=live({pending:true});assert.equal((await call('live-finish',{matchId:pending,expectedVersion:7})).status,409);sql(`delete from public.live_matches where id='${pending}';`);
    const undone=live();
    sql(`update public.live_matches set point_history=jsonb_build_array(jsonb_build_object('games_a',3,'games_b',2,'point_a',3,'point_b',0,'points_a',23,'points_b',18,'completed',false,'is_tiebreak',false,'needs_tiebreak_choice',false)) where id='${undone}';`);
    const staleUndo=await call('live-undo',{matchId:undone,expectedVersion:6});assert.equal(staleUndo.status,409);assert.equal(staleUndo.body.conflict,true);
    const undo=await call('live-undo',{matchId:undone});assert.equal(undo.status,200);assert.equal(undo.body.match.completed,false);assert.equal(undo.body.match.version,8);
    const oldVersion=await call('live-finish',{matchId:undone,expectedVersion:7});assert.equal(oldVersion.status,409);assert.equal(oldVersion.body.conflict,true);
    const point=await call('live-point',{matchId:undone,winner:'a',actionId:crypto.randomUUID()});assert.equal(point.status,200);assert.equal(point.body.match.completed,true);
    assert.equal((await call('live-finish',{matchId:undone,expectedVersion:point.body.match.version})).status,200);
    const choosing=live({complete:false,ga:3,gb:3,pending:true});
    const liveState=await handler(new Request('https://synthetic.invalid/?action=live-state',{method:'GET',headers:{'x-player-session':token('player',ids[0])}}));
    assert.ok((await liveState.json()).liveMatches.some(row=>row.id===choosing&&row.needs_tiebreak_choice));
    assert.equal((await call('live-point',{matchId:choosing,winner:'a',actionId:crypto.randomUUID()})).status,409);
    const staleChoice=await call('live-tiebreak',{matchId:choosing,pointsToWin:5,expectedVersion:6});assert.equal(staleChoice.status,409);assert.equal(staleChoice.body.conflict,true);
    const choice=await call('live-tiebreak',{matchId:choosing,pointsToWin:7,expectedVersion:7});assert.equal(choice.status,200);assert.equal(choice.body.match.tiebreak_to_win,7);
    sql(`update public.live_matches set tiebreak_a=6,tiebreak_b=2 where id='${choosing}';`);
    const last=await call('live-point',{matchId:choosing,winner:'a',actionId:crypto.randomUUID()});assert.equal(last.status,200);assert.equal(last.body.match.completed,true);
    const chosenFinish=await call('live-finish',{matchId:choosing,expectedVersion:last.body.match.version});assert.equal(chosenFinish.status,200);assert.equal(chosenFinish.body.score.tiebreak_to_win,7);
    for(const fixture of [{format:'singles',target:2,ga:2,gb:2,tie:true,ta:5,tb:3},{format:'doubles',ga:4,gb:3,tie:true,ta:7,tb:5}]){const matchId=live(fixture),r=await call('live-finish',{matchId,expectedVersion:7});assert.equal(r.status,200);assert.equal(r.body.score.tiebreak_a,fixture.ta);}
    const start=await call('live-start',{eventId:event,matchType:'singles',teamA:[ids[0]],teamB:[ids[2]],teamAServerId:ids[0],serverPlayerId:ids[0]});assert.equal(start.status,200);
    console.log(`LOCAL_ATOMIC median_ms=${median(times)} median_db_requests=${median(trips)} samples=${times.length}`);
  }finally{sql(cleanup)}
});

test('Watch key and scoring workflow uses the real handler and local PostgreSQL', {skip:!enabled,timeout:120000}, async()=>{
  const config=settings(), notifications=[],metrics={requests:0},source=await readFile(new URL('../netlify/functions/api.mjs',import.meta.url),'utf8'),handler=oldPhoneHandler(source,config,notifications,metrics),tasks=[];
  const cleanup=`delete from public.watch_scoring_tokens where player_id in (${ids.map(x=>`'${x}'`).join(',')}); delete from public.match_scores where event_id='${event}'; delete from public.live_matches where event_id='${event}'; delete from public.events where id in ('${event}','a0000000-0000-4000-8000-000000000098','a0000000-0000-4000-8000-000000000097'); delete from public.players where id in (${ids.map(x=>`'${x}'`).join(',')});`;
  let key='';const watchTimes=new Map();
  async function call(action,body,headers={}){const response=await handler(new Request(`https://synthetic.invalid/?action=${action}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}),{waitUntil:p=>tasks.push(p)});await Promise.all(tasks.splice(0));return {status:response.status,body:await response.json()}}
  const phone=(action,body)=>call(action,{...body,playerId:ids[0]},{'x-player-session':token('player',ids[0])});
  const watch=async body=>{const started=performance.now(),result=await call('watch-score',body,{'x-watch-token':key}),elapsed=performance.now()-started;if(result.body.ok){const name=body.operation.startsWith('team_')?'point':body.operation.startsWith('tiebreak_')?'tiebreak':body.operation,rows=watchTimes.get(name)||[];rows.push(elapsed);watchTimes.set(name,rows)}return result};
  try{
    sql(`${cleanup} insert into public.players(id,name) values ${ids.map((x,i)=>`('${x}','Synthetic watch ${i}')`).join(',')}; insert into public.events(id,event_date,start_time,end_time) values ('${event}',(now() at time zone 'Australia/Sydney')::date,'00:00','23:59'); insert into public.eois(event_id,player_id,status) select '${event}',id,'yes' from public.players where id in (${ids.slice(0,4).map(x=>`'${x}'`).join(',')});`);
    const generated=await phone('watch-key-generate',{});assert.equal(generated.status,200);key=generated.body.token;assert.equal(Buffer.from(key,'base64url').length,32);
    const oldKey=key,oldHash=crypto.createHash('sha256').update(key).digest('hex');
    assert.equal(sql(`select count(*) from public.watch_scoring_tokens where token_hash='${oldHash}';`),'1');
    const status=await phone('watch-key-status',{});assert.equal(status.body.connected,true);assert.equal(Object.hasOwn(status.body,'token'),false);
    const replacement=await phone('watch-key-generate',{});assert.equal(replacement.status,200);key=replacement.body.token;
    assert.equal((await call('watch-score',{operation:'state'},{'x-watch-token':oldKey})).status,401);
    assert.equal((await call('watch-score',{operation:'state'},{'x-watch-token':crypto.randomBytes(32).toString('base64url')})).status,401);
    const currentHash=crypto.createHash('sha256').update(key).digest('hex');
    sql(`update public.watch_scoring_tokens set expires_at=now()-interval '1 minute' where token_hash='${currentHash}';`);assert.equal((await watch({operation:'state'})).status,401);
    sql(`update public.watch_scoring_tokens set expires_at=null where token_hash='${currentHash}'; update public.players set active=false where id='${ids[0]}';`);assert.equal((await watch({operation:'state'})).status,403);
    sql(`update public.players set active=true where id='${ids[0]}';`);
    assert.equal((await watch({operation:'state'})).body.active,false);
    assert.equal((await watch({operation:'state',playerId:ids[5]})).status,400);
    assert.equal((await watch({operation:'state',callerMode:'admin'})).status,400);
    assert.equal((await watch({operation:'state',adminOverride:true})).status,400);
    const started=await phone('live-start',{eventId:event,matchType:'doubles',teamA:ids.slice(0,2),teamB:ids.slice(2,4),teamAServerId:ids[0],teamBServerId:ids[2]});assert.equal(started.status,200);
    sql(`update public.players set email='synthetic@example.invalid',mobile='0000000000',address='Synthetic address' where id='${ids[0]}';`);
    const signedOutState=await handler(new Request('https://synthetic.invalid/?action=state',{method:'GET',headers:{'x-watch-token':key}}));
    const publicPlayer=(await signedOutState.json()).players.find(row=>row.id===ids[0]);
    for(const field of ['email','mobile','address'])assert.equal(Object.hasOwn(publicPlayer,field),false);
    let state=(await watch({operation:'state'})).body;assert.equal(state.active,true);assert.equal(state.matchId,started.body.match.id);assert.equal(state.version,0);assert.match(state.serverLine,/Synthetic watch/);assert.match(state.nextActionId,/^[0-9a-f-]{36}$/i);
    assert.ok((await phone('watch-key-status',{})).body.lastUsedAt);
    sql(`update public.eois set status='no' where event_id='${event}' and player_id='${ids[0]}';`);assert.equal((await watch({operation:'state'})).status,403);
    sql(`update public.eois set status='yes',waitlist_position=1 where event_id='${event}' and player_id='${ids[0]}';`);assert.equal((await watch({operation:'state'})).status,403);
    sql(`update public.eois set waitlist_position=null where event_id='${event}' and player_id='${ids[0]}';`);
    assert.equal((await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:'invalid'})).status,400);
    const premature=await watch({operation:'finish',matchId:state.matchId,expectedVersion:state.version});assert.equal(premature.body.ok,false);
    const outsider=await call('watch-key-generate',{}, {'x-player-session':token('player',ids[5])});assert.equal(outsider.status,200);
    assert.equal((await call('watch-score',{operation:'state'},{'x-watch-token':outsider.body.token})).body.active,false);
    assert.equal((await call('watch-score',{operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId},{'x-watch-token':outsider.body.token})).status,403);
    sql(`insert into public.eois(event_id,player_id,status) values ('${event}','${ids[4]}','yes');`);
    const spectator=await call('watch-key-generate',{}, {'x-player-session':token('player',ids[4])});assert.equal(spectator.status,200);
    assert.equal((await call('watch-score',{operation:'state'},{'x-watch-token':spectator.body.token})).body.active,false);
    assert.equal((await call('watch-score',{operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId},{'x-watch-token':spectator.body.token})).status,403);
    for(const field of ['players','payments','media','notifications','email','mobile','address'])assert.equal(Object.hasOwn(state,field),false);
    const extraEvent='a0000000-0000-4000-8000-000000000098';
    sql(`insert into public.events(id,event_date) values ('${extraEvent}','2097-01-01'); insert into public.live_matches(event_id,team_a_player_ids,team_b_player_ids,created_by) values ('${extraEvent}',array['${ids[0]}','${ids[1]}']::uuid[],array['${ids[2]}','${ids[3]}']::uuid[],'${ids[0]}');`);
    assert.equal((await watch({operation:'state'})).body.multipleMatches,true);sql(`delete from public.events where id='${extraEvent}';`);
    sql(`update public.live_matches set needs_server_choice=true where id='${state.matchId}';`);
    const phoneRequired=await watch({operation:'state'});assert.equal(phoneRequired.body.requiresPhoneAction,true);
    assert.equal((await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId})).body.ok,false);
    sql(`update public.live_matches set needs_server_choice=false where id='${state.matchId}';`);state=(await watch({operation:'state'})).body;
    const compareEvent='a0000000-0000-4000-8000-000000000097',compareMatch='a0000000-0000-4000-8000-000000000096';
    sql(`insert into public.events(id,event_date,start_time,end_time) values ('${compareEvent}',(now() at time zone 'Australia/Sydney')::date-1,'00:00','23:59'); insert into public.eois(event_id,player_id,status) values ('${compareEvent}','${ids[0]}','yes'); insert into public.live_matches(id,event_id,team_a_player_ids,team_b_player_ids,created_by,server_player_id,server_order) values ('${compareMatch}','${compareEvent}',array['${ids[1]}','${ids[2]}']::uuid[],array['${ids[3]}','${ids[4]}']::uuid[],'${ids[0]}','${ids[1]}',array['${ids[1]}','${ids[3]}','${ids[2]}','${ids[4]}']::uuid[]);`);
    const prior=state,first=await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId});assert.equal(first.status,200);assert.equal(first.body.ok,true);assert.equal(first.body.version,1);state=first.body;
    const phoneA=await phone('live-point',{matchId:compareMatch,winner:'a',actionId:crypto.randomUUID()});assert.equal(phoneA.status,200);assert.equal(phoneA.body.match.point_a,1);assert.equal(state.pointScoreA,'15');
    const duplicate=await watch({operation:'team_a_plus',matchId:prior.matchId,expectedVersion:prior.version,actionId:prior.nextActionId});assert.equal(duplicate.body.ok,true);assert.equal(duplicate.body.version,1);
    const wrong=await watch({operation:'team_b_plus',matchId:prior.matchId,expectedVersion:prior.version,actionId:prior.nextActionId});assert.equal(wrong.body.ok,false);
    const second=await watch({operation:'team_b_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId});assert.equal(second.body.ok,true);assert.notEqual(second.body.nextActionId,state.nextActionId);state=second.body;
    const phoneB=await phone('live-point',{matchId:compareMatch,winner:'b',actionId:crypto.randomUUID()});assert.equal(phoneB.status,200);assert.equal(phoneB.body.match.point_b,1);assert.equal(state.pointScoreB,'15');sql(`delete from public.events where id='${compareEvent}';`);
    const watchOnlyLive=await handler(new Request('https://synthetic.invalid/?action=live-state',{method:'GET',headers:{'x-watch-token':key}}));assert.equal(watchOnlyLive.status,401);
    const watchOnlyEoi=await handler(new Request('https://synthetic.invalid/?action=eoi-state',{method:'GET',headers:{'x-watch-token':key}}));assert.equal(watchOnlyEoi.status,401);
    const pollSid='a0000000-0000-4000-8000-000000000095';sql(`insert into public.player_sessions(player_id,session_id,last_seen_at) values ('${ids[0]}','${pollSid}',now()-interval '1 hour');`);
    const lastSeen=sql(`select last_seen_at from public.player_sessions where session_id='${pollSid}';`),pollBefore=metrics.requests,pollStarted=performance.now();
    const phoneState=await handler(new Request('https://synthetic.invalid/?action=live-state',{method:'GET',headers:{'x-player-session':token('player',ids[0],false,pollSid)}}));assert.equal((await phoneState.json()).liveMatches.find(row=>row.id===state.matchId).point_b,1);
    console.log(`LOCAL_PHONE_POLL ms=${Math.round((performance.now()-pollStarted)*10)/10} db_requests=${metrics.requests-pollBefore} samples=1`);
    assert.equal(sql(`select last_seen_at from public.player_sessions where session_id='${pollSid}';`),lastSeen);
    const adminLive=await handler(new Request('https://synthetic.invalid/?action=live-state',{method:'GET',headers:{authorization:`Bearer ${token('admin')}`}}));assert.equal(adminLive.status,200);
    const playerEoi=await handler(new Request('https://synthetic.invalid/?action=eoi-state',{method:'GET',headers:{'x-player-session':token('player',ids[0])}}));assert.equal(playerEoi.status,200);
    let captured,release;const paused=new Promise(resolve=>captured=resolve),gate=new Promise(resolve=>release=resolve);
    metrics.beforeFetch=async input=>{const url=new URL(input);if(url.pathname.endsWith('/live_matches')&&url.searchParams.has('completed')){metrics.beforeFetch=null;captured();await gate}};
    const racingWatch=watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId});
    await paused;let racingPhone;try{racingPhone=await phone('live-point',{matchId:state.matchId,winner:'b',actionId:crypto.randomUUID()})}finally{release()}assert.equal(racingPhone.status,200);
    const raceResult=await racingWatch;assert.equal(raceResult.body.conflict,true);assert.equal(raceResult.body.version,racingPhone.body.match.version);state=raceResult.body;
    let patchCaptured,patchRelease;const patchPaused=new Promise(resolve=>patchCaptured=resolve),patchGate=new Promise(resolve=>patchRelease=resolve),raceAction=state.nextActionId;
    metrics.beforeFetch=async(input,options)=>{const url=new URL(input);if(url.pathname.endsWith('/live_matches')&&options?.method==='PATCH'&&url.searchParams.has('version')){metrics.beforeFetch=null;patchCaptured();await patchGate}};
    const racingPatch=watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:raceAction});
    await patchPaused;let phoneAtPatch;try{phoneAtPatch=await phone('live-point',{matchId:state.matchId,winner:'b',actionId:crypto.randomUUID()})}finally{patchRelease()}assert.equal(phoneAtPatch.status,200);
    const patchResult=await racingPatch;assert.equal(patchResult.body.conflict,true);assert.equal(patchResult.body.version,phoneAtPatch.body.match.version);assert.equal(sql(`select count(*) from public.live_point_actions where action_id='${raceAction}';`),'0');state=patchResult.body;
    const undo=await watch({operation:'undo',matchId:state.matchId,expectedVersion:state.version});assert.equal(undo.body.ok,true);state=undo.body;
    assert.equal((await watch({operation:'undo',matchId:state.matchId,expectedVersion:state.version-1})).body.conflict,true);
    const stale=await watch({operation:'team_b_plus',matchId:state.matchId,expectedVersion:state.version-1,actionId:state.nextActionId});assert.equal(stale.body.conflict,true);
    sql(`update public.live_matches set games_a=3,games_b=3,point_a=0,point_b=0,needs_tiebreak_choice=true,version=version+1 where id='${state.matchId}';`);
    state=(await watch({operation:'state'})).body;assert.equal(state.needsTiebreakChoice,true);
    const blockedPoint=await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId});assert.equal(blockedPoint.body.ok,false);assert.equal(blockedPoint.body.needsTiebreakChoice,true);
    const choice=await watch({operation:'tiebreak_7',matchId:state.matchId,expectedVersion:state.version});assert.equal(choice.body.ok,true);assert.equal(choice.body.tiebreakToWin,7);state=choice.body;
    sql(`update public.live_matches set tiebreak_a=6,tiebreak_b=2,version=version+1 where id='${state.matchId}';`);
    state=(await watch({operation:'state'})).body;state=(await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId})).body;assert.equal(state.completed,true);assert.equal(state.canFinish,true);
    const completedState=(await watch({operation:'state'})).body;assert.equal(completedState.matchId,state.matchId);assert.equal(completedState.completed,true);state=completedState;
    const undoneComplete=await watch({operation:'undo',matchId:state.matchId,expectedVersion:state.version});assert.equal(undoneComplete.body.completed,false);state=undoneComplete.body;
    state=(await watch({operation:'team_a_plus',matchId:state.matchId,expectedVersion:state.version,actionId:state.nextActionId})).body;assert.equal(state.completed,true);
    const matchId=state.matchId,version=state.version;assert.equal((await watch({operation:'finish',matchId,expectedVersion:version-1})).body.conflict,true);
    const finished=await watch({operation:'finish',matchId,expectedVersion:version});assert.equal(finished.body.completed,true);
    const retry=await watch({operation:'finish',matchId,expectedVersion:version});assert.equal(retry.body.ok,true);assert.equal(sql(`select count(*) from public.match_scores where source_live_match_id='${matchId}';`),'1');assert.equal(notifications.length,1);
    assert.equal((await watch({operation:'undo',matchId,expectedVersion:version})).status,403);
    assert.equal((await call('watch-score',{operation:'finish',matchId,expectedVersion:version},{'x-watch-token':outsider.body.token})).status,403);
    assert.equal((await call('watch-score',{operation:'finish',matchId,expectedVersion:version},{'x-watch-token':spectator.body.token})).status,403);
    const next=await phone('live-start',{eventId:event,matchType:'doubles',teamA:ids.slice(0,2),teamB:ids.slice(2,4),teamAServerId:ids[0],teamBServerId:ids[2]});assert.equal(next.status,200);
    sql(`update public.live_matches set games_a=3,games_b=3,needs_tiebreak_choice=true,version=version+1 where id='${next.body.match.id}';`);
    const tieState=(await watch({operation:'state'})).body,choice5=await watch({operation:'tiebreak_5',matchId:tieState.matchId,expectedVersion:tieState.version});assert.equal(choice5.body.tiebreakToWin,5);
    assert.equal((await watch({operation:'tiebreak_7',matchId:tieState.matchId,expectedVersion:tieState.version})).body.conflict,true);
    assert.equal((await phone('live-abandon',{matchId:tieState.matchId})).status,200);
    assert.equal((await call('paid',{eventId:event,playerId:ids[0]},{'x-watch-token':key})).status,401);
    assert.equal((await call('eoi',{eventId:event,playerId:ids[0],status:'no'},{'x-watch-token':key})).status,401);
    assert.notEqual((await call('admin-save-event',{eventId:event},{'x-watch-token':key})).status,200);
    assert.notEqual((await call('admin-save-event',{eventId:event},{authorization:`Bearer ${key}`})).status,200);
    assert.equal((await call('player-update-profile',{playerId:ids[0],name:'Not authorized'},{'x-watch-token':key})).status,401);
    assert.equal((await phone('watch-key-revoke',{})).status,200);assert.equal((await watch({operation:'state'})).status,401);
    for(const [name,values] of watchTimes)console.log(`LOCAL_WATCH ${name} median_ms=${median(values)} slowest_ms=${Math.round(Math.max(...values)*10)/10} samples=${values.length}`);
  }finally{sql(cleanup)}
});
