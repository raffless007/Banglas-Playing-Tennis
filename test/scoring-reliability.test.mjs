import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';

const source=await readFile(new URL('../netlify/functions/api.mjs',import.meta.url),'utf8');
const client=await readFile(new URL('../public/js/scoring-reliability.js',import.meta.url),'utf8');
const owner='34997eec-ac2e-46c0-8473-816733ef0df5', participant='11111111-1111-4111-a111-111111111111';
const other='22222222-2222-4222-a222-222222222222', fourth='33333333-3333-4333-a333-333333333333';
const secret='synthetic-reliability-secret';
function fixture(){
  let clock=Date.parse('2026-10-21T08:59:59Z');
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const state={active:true,revoked:false,pinUpdated:null,adminLastSeen:new Clock().toISOString(),auditHeld:false,audits:[],tasks:[],scores:[],calls:[],gate:null};
  const events=[{id:'old',event_date:'2026-10-14',start_time:'20:00:00',end_time:'22:00:00',timezone:'Australia/Sydney',account_closed:true,court_fee:54,ball_fee:1,location:'Synthetic court',suburb:'Test',max_players:6},{id:'next',event_date:'2026-10-21',start_time:'20:00:00',end_time:'22:00:00',timezone:'Australia/Sydney',location:'Synthetic court',suburb:'Test'}];
  const eois=[participant,other,fourth,owner].map(player_id=>({event_id:'old',player_id,status:'yes',waitlist_position:null}));
  const roster=[owner,participant,other,fourth].map(id=>({id,name:id===owner?'Synthetic owner':'Synthetic participant',active:true}));
  const fetch=async(input,options={})=>{
    const url=new URL(input),table=url.pathname.split('/').at(-1),method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    state.calls.push({table,method,body});
    const json=rows=>new Response(JSON.stringify(rows));
    if(table==='audit_log'&&method==='POST'){
      if(state.auditHeld)await new Promise(resolve=>{state.gate=resolve;});
      state.audits.push(body);return new Response('');
    }
    if(table==='players'){
      if(!state.active)return json([]);
      const id=url.searchParams.get('id')?.slice(3);
      return json((id?roster.filter(row=>row.id===id):roster).map(row=>({...row,pin_updated_at:state.pinUpdated})));
    }
    if(table==='player_sessions')return method==='GET'?json(state.revoked?[]:[{session_id:'player-session',last_seen_at:new Clock().toISOString()}]):new Response('');
    if(table==='admin_sessions')return method==='GET'?json([{session_id:'admin-session',last_seen_at:state.adminLastSeen}]):new Response('');
    if(table==='events'){
      const id=url.searchParams.get('id')?.slice(3);
      if(method==='PATCH'){Object.assign(events.find(row=>row.id===id),body);return new Response('');}
      return json(id?events.filter(row=>row.id===id):events.filter(row=>!row.deleted_at));
    }
    if(table==='eois'){
      if(method==='POST'){const at=eois.findIndex(row=>row.event_id===body.event_id&&row.player_id===body.player_id);if(at>=0)eois[at]=body;else eois.push(body);return new Response('');}
      return json(eois.filter(row=>(!url.searchParams.get('event_id')||row.event_id===url.searchParams.get('event_id').slice(3))&&(!url.searchParams.has('status')||row.status==='yes')));
    }
    if(table==='match_scores'){
      if(method==='POST'){
        const inserted=[];
        for(const row of body){if(!state.scores.some(item=>item.id===row.id)){const saved={...row,id:row.id||crypto.randomUUID()};state.scores.push(saved);inserted.push(saved);}}
        return json(inserted);
      }
      if(method==='PATCH'){const row=state.scores.find(row=>row.id===url.searchParams.get('id')?.slice(3));Object.assign(row,body);return json([row]);}
      return json(state.scores.filter(row=>!url.searchParams.get('id')||row.id===url.searchParams.get('id').slice(3)));
    }
    return method==='GET'?json([]):new Response('');
  };
  const code=source.replace(/^import[\s\S]*?;\n/gm,'').replace(/^export \{[^}]*\};/gm,'').replace('export default async (req, context = {}) =>','return async (req, context = {}) =>');
  const handler=new Function('deps',`const {createHmac,pbkdf2Sync,randomBytes,randomUUID,timingSafeEqual,fetch,process,Date,activePlayerIds,notifyPlayers}=deps;\n${code}`)({...crypto,fetch,Date:Clock,activePlayerIds:async()=>[],notifyPlayers:async()=>({sent:0}),process:{env:{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic',ADMIN_SESSION_SECRET:secret}}});
  function token(type,id=participant){const raw=Buffer.from(JSON.stringify({type,sub:type==='player'?id:undefined,sid:type==='player'?'player-session':'admin-session',iat:clock-1000,exp:clock+86400000})).toString('base64url');return `${raw}.${crypto.createHmac('sha256',secret).update(raw).digest('base64url')}`;}
  async function request(action,body={},auth={player:participant},background=true){
    const headers={'content-type':'application/json'};
    if(auth.player)headers['x-player-session']=token('player',auth.player);
    if(auth.admin)headers.authorization=`Bearer ${typeof auth.admin==='string'?auth.admin:token('admin')}`;
    return handler(new Request(`https://app.invalid/?action=${action}`,{method:'POST',headers,body:JSON.stringify(body)}),background?{waitUntil:task=>state.tasks.push(task)}:{});
  }
  return {state,events,eois,request,token,now:value=>{clock=Date.parse(value);},flush:()=>Promise.all(state.tasks)};
}
const match={matchType:'doubles',gamesToWin:4,teamA:[participant,other],teamB:[owner,fourth],gamesA:'3',gamesB:'3',tiebreakA:'5',tiebreakB:'2'};
const scoreBody=(overrides={})=>({eventId:'old',submittedBy:participant,matches:[match],submissionId:'44444444-4444-4444-a444-444444444444',...overrides});

test('participants can save after 24 hours up to, but not at, the next event start',async()=>{
  const app=fixture();
  assert.equal((await app.request('score',scoreBody())).status,200);
  assert.equal(app.state.scores[0].games_a,4);assert.equal(app.state.scores[0].games_b,3);
  app.now('2026-10-21T09:00:00Z');
  const closed=await app.request('score',scoreBody());assert.equal(closed.status,403);assert.match((await closed.json()).error,/next session/);
  await app.flush();assert.match(app.state.audits.at(-1).details.failureReason,/next session/);
});
test('cancelled/deleted next events are skipped; venue timezone and second-court opening are respected',async()=>{
  const app=fixture();app.events[1].cancellation_status='cancelled';
  app.events.push({id:'later',event_date:'2026-10-28',start_time:'20:00:00',end_time:'22:00:00',timezone:'Australia/Sydney',court_2_enabled:true,court_2_start_time:'19:00:00'});
  app.now('2026-10-28T07:59:59Z');assert.equal((await app.request('score',scoreBody())).status,200);
  app.now('2026-10-28T08:00:00Z');assert.equal((await app.request('score',scoreBody())).status,403);
  app.events[2].deleted_at=new Date().toISOString();assert.equal((await app.request('score',scoreBody())).status,200);
});
test('admins add and update closed-week scores without attendance or time restrictions; players cannot invoke admin add',async()=>{
  const app=fixture();app.now('2026-11-21T09:00:00Z');app.state.adminLastSeen='2026-11-21T09:00:00Z';app.eois.splice(0);
  const created=await app.request('admin-add-score',scoreBody(),{admin:true});assert.equal(created.status,200);
  const score=app.state.scores[0];
  const updated=await app.request('admin-update-score',{...match,scoreId:score.id,gamesA:4,gamesB:1},{admin:true});assert.equal(updated.status,200);assert.equal(score.games_b,1);
  assert.equal((await app.request('admin-add-score',scoreBody())).status,401);
  assert.equal((await app.request('score',scoreBody())).status,403);
});
test('score retries are idempotent, empty game scores are rejected and nonparticipants cannot save',async()=>{
  const app=fixture();await app.request('score',scoreBody());await app.request('score',scoreBody());assert.equal(app.state.scores.length,1);
  const empty=await app.request('score',scoreBody({matches:[{...match,gamesA:''}]}));assert.equal(empty.status,400);
  app.eois.splice(0);assert.equal((await app.request('score',scoreBody())).status,403);
  await app.flush();
});
test('3–3 needs a valid winning tie-break; Singles race-to-2 remains 2–2',async()=>{
  const app=fixture();assert.equal((await app.request('score',scoreBody({matches:[{...match,tiebreakA:4,tiebreakB:3}]}))).status,400);
  const response=await app.request('score',scoreBody({matches:[{...match,matchType:'singles',gamesToWin:2,teamA:[participant],teamB:[owner],gamesA:2,gamesB:2}]}));
  assert.equal(response.status,200);assert.equal(app.state.scores.at(-1).games_a,2);
});
test('confirmed writes return while audit work is registered with waitUntil; fallback awaits logging',async()=>{
  const app=fixture();app.state.auditHeld=true;
  const response=await app.request('score',scoreBody());assert.equal(response.status,200);assert.equal(app.state.scores.length,1);assert.ok(app.state.tasks.length);assert.match(response.headers.get('server-timing'),/save;dur=/);
  for(let i=0;i<10&&!app.state.gate;i++)await Promise.resolve();
  assert.equal(app.state.audits.length,0);app.state.auditHeld=false;app.state.gate?.();await app.flush();assert.equal(app.state.audits.length,1);
  const local=fixture();await local.request('score',scoreBody(),{player:participant},false);assert.equal(local.state.audits.length,1);
});
test('EOI reads the event attendance only once and persists before audit completion',async()=>{
  const app=fixture();app.now('2026-10-20T09:00:00Z');app.state.auditHeld=true;
  const response=await app.request('eoi',{eventId:'next',playerId:participant,status:'yes'});assert.equal(response.status,200);
  assert.equal(app.state.calls.filter(call=>call.table==='eois'&&call.method==='GET').length,1);
  assert.ok(app.eois.some(row=>row.event_id==='next'&&row.player_id===participant));
  for(let i=0;i<10&&!app.state.gate;i++)await Promise.resolve();app.state.auditHeld=false;app.state.gate?.();await app.flush();
});
test('only Rafeed authenticated as the bound immutable player can obtain profile admin',async()=>{
  const app=fixture();
  assert.equal((await app.request('admin-profile-login',{playerId:owner})).status,403);
  assert.equal((await app.request('admin-profile-login',{playerId:owner},{})).status,403);
  const login=await app.request('admin-profile-login',{playerId:owner},{player:owner});assert.equal(login.status,200);
  const admin=(await login.json()).token;
  assert.equal((await app.request('admin-add-score',scoreBody(),{player:owner,admin})).status,200);
  assert.equal((await app.request('admin-add-score',scoreBody(),{player:participant,admin})).status,401);
  app.state.revoked=true;assert.equal((await app.request('admin-add-score',scoreBody(),{player:owner,admin})).status,401);
});
test('linked Admin expires after one idle hour and observes PIN resets',async()=>{
  const app=fixture(),login=await app.request('admin-profile-login',{playerId:owner},{player:owner}),admin=(await login.json()).token;
  app.state.pinUpdated='2026-10-21T09:00:00Z';assert.equal((await app.request('admin-add-score',scoreBody(),{player:owner,admin})).status,401);
  app.state.pinUpdated=null;app.state.adminLastSeen='2026-10-21T07:59:59Z';assert.equal((await app.request('admin-add-score',scoreBody(),{player:owner,admin})).status,401);
});

function clientFixture(fetch){
  const values=new Map(),notices=[],nodes={scoreEntry:{querySelectorAll:()=>[],querySelector:()=>null},gate:{classList:{remove(){}}}};
  const context={console,Date,Intl,Map,Set,JSON,Promise,TypeError,Error,AbortController,crypto,API:'/.netlify/functions/api',playerToken:'synthetic-player',adminToken:null,currentPlayerId:participant,scoreEventId:'old',scoreDraftEventId:'old',scoreDrafts:[{matchType:'doubles',teamA1:participant,teamA2:other,teamB1:owner,teamB2:fourth,gamesA:3,gamesB:3,tiebreakA:5,tiebreakB:2}],data:{events:[],scores:[],eois:[]},eoiPending:new Set(),upcoming:()=>[{id:'old'}],selected:0,fetch,
    localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},setTimeout:()=>99,clearTimeout(){},
    renderPlayerChooser(){},renderScores(){},renderAdminScores(){},renderAdmin(){},renderPlay(){},adminCall(){},submitScores(){},submitEoi(){},transportRequest(){},scoringClosesFor(){},scoringOpenFor(){},scoringWindowText(){},
    upsertLocalEoi(eventId,playerId,status,waitlist_position=null){const row={event_id:eventId,player_id:playerId,status,waitlist_position},at=context.data.eois.findIndex(item=>item.event_id===eventId&&item.player_id===playerId);if(at<0)context.data.eois.push(row);else context.data.eois[at]=row;},
    $:id=>nodes[id]||null,captureDrafts(){},blankDraft:()=>({}),notify:message=>notices.push(message),refresh:async()=>{},request:async()=>({saved:1,scores:[]}),startTime:event=>event.start_time,document:{querySelectorAll:()=>[]},fmt:date=>date.toISOString(),eventMoment:(event,time)=>new Date(`${event.event_date}T${time}`)};
  vm.createContext(context);vm.runInContext(client,context);return {context,values,notices};
}
test('client write timeout is ambiguous, not a claimed failure, and confirmed admin headers are forwarded',async()=>{
  const app=clientFixture(async()=>{const error=new Error('abort');error.name='AbortError';throw error;});
  await assert.rejects(app.context.transportRequest('eoi','POST',{}),error=>error.uncertain===true&&/may have reached/.test(error.message));
  let options;app.context.fetch=async(url,input)=>{options=input;return new Response('{"ok":true}');};app.context.adminToken='synthetic-admin';
  assert.equal((await app.context.transportRequest('score','POST',{},true)).ok,true);assert.equal(options.headers.authorization,'Bearer synthetic-admin');
});
test('score drafts survive a failed save and reuse the same submission key on retry',async()=>{
  const app=clientFixture(),attempts=[];let fail=true;
  app.context.request=async(action,method,body)=>{attempts.push(body);if(fail)throw Object.assign(new Error('unknown'),{uncertain:true});return {saved:1,scores:[]};};
  await app.context.submitScores('old');assert.equal(app.values.size,1);assert.equal(app.context.scoreDrafts[0].gamesA,3);
  fail=false;await app.context.submitScores('old');assert.equal(attempts[0].submissionId,attempts[1].submissionId);assert.equal(app.values.size,0);
});
test('uncertain EOI responses are reconciled against server data instead of falsely rolling back',async()=>{
  const app=clientFixture();app.context.data.eois=[{event_id:'old',player_id:participant,status:'no'}];
  app.context.request=async action=>{if(action==='eoi')throw Object.assign(new Error('network'),{uncertain:true});return {eois:[{event_id:'old',player_id:participant,status:'yes',waitlist_position:null}]};};
  await app.context.submitEoi('old','yes');assert.equal(app.context.data.eois[0].status,'yes');assert.match(app.notices.at(-1),/saved and confirmed/);assert.equal(app.context.eoiPending.size,0);
});
test('client score deadline uses venue time and skips cancelled sessions',()=>{
  const app=clientFixture();
  app.context.data.events=[{id:'old',event_date:'2026-10-14',start_time:'20:00:00',timezone:'Australia/Sydney'},{id:'cancelled',event_date:'2026-10-21',start_time:'20:00:00',cancellation_status:'cancelled'},{id:'next',event_date:'2026-10-28',start_time:'19:30:00',timezone:'Australia/Sydney'}];
  assert.equal(app.context.scoringClosesFor(app.context.data.events[0]).toISOString(),'2026-10-28T08:30:00.000Z');
});
