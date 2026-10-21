// Isolated visual preview of the actual candidate. All API responses are
// synthetic and all writes stay in this process. No production credentials.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const port = Number(process.env.BPT_PREVIEW_PORT || 4174);
const names = ['Raf Abrar','Nabil Mohsin','Shadeed Mahmud','Sanjid Mahmood Hamim','Eram','Sunny Rahman'];
const players = names.map((name,index) => ({ id:`demo-${index+1}`,name,active:true,is_guest:false,pin_configured:true,email:'',mobile:'',address:'',avatar_url:null,push_enabled:true }));
const today = new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney'}).format(new Date())+'T12:00:00Z');
const nextWednesday = new Date(today); nextWednesday.setUTCDate(today.getUTCDate()+(3-today.getUTCDay()+7)%7);
const events = Array.from({length:7},(_,i)=>{
  const day=new Date(nextWednesday); day.setUTCDate(day.getUTCDate()+(i-3)*7);
  return {id:`session-${i}`,event_date:day.toISOString().slice(0,10),start_time:'19:30:00',end_time:'22:00:00',timezone:'Australia/Sydney',location:'Civic Park Tennis Courts',suburb:'Pendle Hill',entry_pin:'3120',court_1_name:'Court 1',court_fee:54,ball_fee:1,court_2_enabled:false,court_2_name:'Court 2',court_2_start_time:'19:30:00',court_2_end_time:'22:00:00',court_2_fee:54,account_closed:i<2,max_players:6,cancellation_status:'scheduled',deleted_at:null};
});
const eois=events.flatMap((e,index)=>players.map((p,i)=>({event_id:e.id,player_id:p.id,status:index>=3&&i===5?'no':'yes',waitlist_position:null,attendance_status:index<3?'attended':'pending',updated_at:new Date().toISOString()})));
const payments=events.filter((_,i)=>i<3).flatMap(e=>players.map((p,i)=>({event_id:e.id,player_id:p.id,amount:10,paid:i<4,paid_at:i<4?`${e.event_date}T12:${String(15+i*8).padStart(2,'0')}:00Z`:null})));
const scores=events.filter((_,i)=>i<3).flatMap(e=>Array.from({length:6},(_,i)=>({id:`${e.id}-match-${i}`,event_id:e.id,match_type:'doubles',team_a_player_ids:[players[0].id,players[1+i%2].id],team_b_player_ids:[players[3].id,players[4+i%2].id],games_a:i===5?2:4,games_b:i===2?0:i===4?3:2,points_a:17+i,points_b:12+i,tiebreak_a:i===4?5:null,tiebreak_b:i===4?3:null,submitted_by:players[0].id,created_at:`${e.event_date}T${String(10+i).padStart(2,'0')}:00:00Z`,updated_at:new Date().toISOString()})));
scores.forEach(score=>{ if(score.games_a===2)score.games_b=4; });
const badges=[
  {id:'form',name:'Form King',description:'Won at least 75% of the most recent five completed matches.',min_played:5,min_win_pct:75,match_window:5,sort_order:0},
  {id:'regular',name:'Regular',description:'Attended four of the five most recent sessions.',min_attendance:4,attendance_window:5,sort_order:1},
  {id:'paid',name:'Paid Up Pro',description:'All payments cleared within 24 hours of the session ending.',min_attendance:5,min_paid_rate:100,payment_within_hours:24,sort_order:2},
  {id:'veteran',name:'Veteran',description:'More than 50 completed matches.',min_played:51,sort_order:3},
  {id:'building',name:'Building Form',description:'A 40% win rate in the most recent five matches.',min_played:5,min_win_pct:40,match_window:5,sort_order:4},
  {id:'fresh',name:'Fresh Legs',description:'Between one and five completed matches.',min_played:1,max_played:5,sort_order:5},
].map(item=>({...item,enabled:true}));
const media=Array.from({length:6},(_,i)=>({id:`photo-${i}`,player_id:players[i%3].id,title:['Wednesday highlights','Under the lights','Match point','The evening crew','Courtside','One more set'][i],captured_at:events[2].event_date,created_at:new Date().toISOString(),media_type:'image',mime_type:'image/svg+xml',original_name:`sample-${i}.svg`,file_size:1200000,album:'Wednesday nights',is_favorite:i===1,public_url:`/preview/court.svg?variant=${i}`}));
const notifications=[{id:'notice-1',title:'You’re in · Wednesday tennis',body:'Your spot is confirmed at Civic Park. Court 1 · 7:30–10pm.',notification_type:'eoi',url:'/?page=play',created_at:new Date().toISOString(),read_at:null}];
const liveMatches=[];
// Reuse the app's existing pure scoring helpers in this in-memory preview.
// No separate demo rules can drift from the actual Singles/Doubles rules.
const clientSource = (await readFile(path.join(root,'index.html'),'utf8')).match(/<script>([\s\S]*?)<\/script>/)[1];
const helperLines = [
  clientSource.match(/    function nextServerClient[^\n]+/)[0],
  clientSource.match(/    function liveSnapshotClient[^\n]+/)[0],
  clientSource.match(/    liveAdvanceClient=function[^\n]+/)[0],
];
const scoring = new Function('let liveAdvanceClient;\n'+helperLines.join('\n')+'\nreturn {advance:liveAdvanceClient,snapshot:liveSnapshotClient};')();
const pointActions = new Set();
const state=()=>({players,events,eois,payments,scores,notes:[],badges,liveMatches,notifications,profileAdmin:true,sessionPlayerId:players[0].id,mediaLimit:5*1024**3,serverNow:new Date().toISOString()});
const locations=[{id:'court-1',name:'Civic Park Tennis Courts',suburb:'Pendle Hill',entry_pin:'3120',court_1_fee:54,court_2_fee:54,ball_fee:1,active:true}];
const seed = `<script>localStorage.setItem('bpt-player-id','demo-1');localStorage.setItem('bpt-player-token','synthetic-preview-session');localStorage.setItem('bpt-player-last-activity',String(Date.now()));localStorage.removeItem('bpt-admin-token');localStorage.removeItem('bpt-admin-last-activity');localStorage.removeItem('bpt-state-cache-v1');Object.defineProperty(navigator,'standalone',{value:true,configurable:true});</script>`;
const loginSeed = `<script>localStorage.removeItem('bpt-player-token');localStorage.removeItem('bpt-admin-token');localStorage.removeItem('bpt-admin-last-activity');localStorage.removeItem('bpt-state-cache-v1');</script>`;
const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Server-Timing':'synthetic;dur=25'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/preview/overview') {
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
      return res.end(await readFile(new URL('../design-preview/overview.html',import.meta.url)));
    }
    if(/^\/preview\/screenshots\/[a-z-]+\.jpg$/.test(url.pathname)) {
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});
      return res.end(await readFile(new URL('../design-preview/screenshots/'+path.basename(url.pathname),import.meta.url)));
    }
    if(url.pathname==='/.netlify/functions/api') {
      const action=url.searchParams.get('action');
      let body={}; if(req.method!=='GET'){let text='';for await(const chunk of req)text+=chunk;body=JSON.parse(text||'{}');}
      if(action==='state')return send(res,state());
      if(action==='admin-state')return send(res,{players,badges,locations,guestHistory:[]});
      if(action==='media-state')return send(res,{media,mediaUsage:7200000,mediaLimit:5*1024**3});
      if(action==='eoi-state')return send(res,{eois});
      if(action==='live-state')return send(res,{liveMatches});
      if(action==='notification-state')return send(res,{notifications});
      if(action==='realtime-config')return send(res,{configured:false});
      if(action==='sync-version')return send(res,{version:1});
      if(action==='push-status')return send(res,{configured:false,enabled:true,preferences:{}});
      if(action==='passkey-list')return send(res,{passkeys:[],pinConfigured:true});
      if(action==='player-pin-status')return send(res,{pinConfigured:true});
      if(action==='player-login'||action==='admin-login')return send(res,{token:'synthetic-preview-session'});
      if(action==='admin-profile-login')return send(res,{ok:true,token:'synthetic-admin'});
      if(action==='score'||action==='admin-add-score'){const added=(body.matches||[]).map((m,i)=>({id:body.submissionId+'-'+i,event_id:body.eventId,submitted_by:body.submittedBy,match_type:m.matchType,games_to_win:Number(m.gamesToWin),team_a_player_ids:m.teamA,team_b_player_ids:m.teamB,games_a:Number(m.gamesA)===3&&Number(m.gamesB)===3&&Number(m.tiebreakA)>Number(m.tiebreakB)?4:Number(m.gamesA),games_b:Number(m.gamesA)===3&&Number(m.gamesB)===3&&Number(m.tiebreakB)>Number(m.tiebreakA)?4:Number(m.gamesB),tiebreak_a:Number(m.tiebreakA),tiebreak_b:Number(m.tiebreakB),created_at:new Date().toISOString()}));for(const row of added)if(!scores.some(x=>x.id===row.id))scores.push(row);return send(res,{ok:true,saved:added.length,scores:added});}
      if(action==='eoi'){const row=eois.find(x=>x.event_id===body.eventId&&x.player_id===body.playerId);if(row)row.status=body.status;return send(res,{ok:true,waitlisted:false});}
      if(action==='paid'){const row=payments.find(x=>x.event_id===body.eventId&&x.player_id===body.playerId);if(row){row.paid=true;row.paid_at=new Date().toISOString();}return send(res,{ok:true});}
      if(action==='live-start') {
        const a=body.teamA,b=body.teamB,first=body.teamAServerId||body.serverPlayerId;
        const order=body.matchType==='singles'?[first,...[...a,...b].filter(id=>id!==first)]:[first,body.teamBServerId,...a.filter(id=>id!==first),...b.filter(id=>id!==body.teamBServerId)];
        const match={id:'demo-live-'+Date.now(),event_id:body.eventId,match_type:body.matchType,games_to_win:Number(body.gamesToWin),team_a_player_ids:a,team_b_player_ids:b,server_order:order,server_player_id:first,server_index:0,games_a:0,games_b:0,point_a:0,point_b:0,points_a:0,points_b:0,tiebreak_a:0,tiebreak_b:0,is_tiebreak:false,completed:false,needs_server_choice:false,point_history:[],started_at:new Date().toISOString(),created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
        liveMatches.push(match);return send(res,{ok:true,match});
      }
      if(['live-point','live-undo','live-server','live-abandon','live-finish'].includes(action)) {
        const index=liveMatches.findIndex(x=>x.id===body.matchId),current=liveMatches[index];
        if(!current)return send(res,{error:'Live match not found'},404);
        if(action==='live-abandon'||action==='live-finish'){liveMatches.splice(index,1);return send(res,{ok:true,matchId:body.matchId});}
        if(action==='live-point'&&!pointActions.has(body.actionId)){
          pointActions.add(body.actionId);const history=[...current.point_history,scoring.snapshot(current)];
          liveMatches[index]={...scoring.advance(current,body.winner),point_history:history,updated_at:new Date().toISOString()};
        }
        if(action==='live-undo'&&current.point_history.length){const history=[...current.point_history],previous=history.pop();liveMatches[index]={...current,...previous,point_history:history};}
        if(action==='live-server')Object.assign(current,{server_player_id:body.serverPlayerId,server_index:current.server_order.indexOf(body.serverPlayerId)});
        const match=liveMatches[index];return send(res,{ok:true,match,gameFinished:match.game_finished,completed:match.completed,nextServerId:match.server_player_id});
      }
      if(action==='media-favorite'){const item=media.find(x=>x.id===body.mediaId);if(item)item.is_favorite=body.favorite??!item.is_favorite;return send(res,{ok:true,isFavorite:item?.is_favorite});}
      if(action==='notification-read-all'||action==='notification-read'){notifications.forEach(x=>x.read_at=new Date().toISOString());return send(res,{ok:true});}
      if(action==='admin-audit-log')return send(res,{rows:[{id:'audit-1',action:'admin-save-event',actor_name:'Preview admin',actor_type:'admin',created_at:new Date().toISOString(),outcome:'success',details:{location:'Civic Park Tennis Courts'}}]});
      if(action==='admin-alert-log'||action==='admin-alert-schedules')return send(res,{rows:[]});
      if(action==='admin-set-attendance'){const row=eois.find(x=>x.event_id===body.eventId&&x.player_id===body.playerId);if(row)row.attendance_status=body.attendanceStatus;return send(res,{ok:true});}
      if(action==='admin-save-badge'){const row=badges.find(x=>x.id===body.id);if(row&&body.name)row.name=body.name;return send(res,{ok:true});}
      return send(res,{ok:true,created:0});
    }
    if(url.pathname==='/preview/geocode')return send(res,{results:[{name:'Pendle Hill',latitude:0,longitude:0}]});
    if(url.pathname==='/preview/forecast')return send(res,{hourly:{time:events.flatMap(e=>['19','20','21','22'].map(h=>`${e.event_date}T${h}:00`)),temperature_2m:Array(28).fill(18),precipitation_probability:Array(28).fill(5),precipitation:Array(28).fill(0),weather_code:Array(28).fill(0),wind_speed_10m:Array(28).fill(7)}});
    if(url.pathname==='/preview/court.svg') {
      const colors=['#40624d','#25483e','#6e8065','#4b6a65','#668170','#344e3e'];
      const color=colors[Number(url.searchParams.get('variant'))%colors.length];
      res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450"><rect width="600" height="450" fill="${color}"/><g transform="translate(300 220) rotate(-17)"><rect x="-165" y="-220" width="330" height="440" rx="3" fill="#2d6651" stroke="#e4ecd8" stroke-width="4"/><path d="M-125-220v440M125-220v440M-125-110h250M-125 110h250M0-110v220M-180 0h360" fill="none" stroke="#e4ecd8" stroke-width="3"/><path d="M-180 0h360" stroke="#112f27" stroke-width="9"/><circle cx="75" cy="135" r="12" fill="#daed82"/></g><rect width="600" height="450" fill="#051e22" opacity=".12"/></svg>`);
    }
    let file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(root+path.sep))return send(res,{error:'Not found'},404);
    let bytes=await readFile(file);
    if(file.endsWith('index.html'))bytes=Buffer.from(bytes.toString().replace('<script>',(url.searchParams.get('preview')==='login'?loginSeed:seed)+'<script>').replaceAll('https://geocoding-api.open-meteo.com/v1/search','/preview/geocode').replaceAll('https://api.open-meteo.com/v1/forecast','/preview/forecast').replace("navigator.serviceWorker.register('/sw.js').catch(()=>{})","Promise.resolve()").replace('</body>','<div class="preview-ribbon">DESIGN PREVIEW · SAMPLE DATA</div></body>'));
    if(file.endsWith('/js/app.js'))bytes=Buffer.from(bytes.toString().replaceAll('https://geocoding-api.open-meteo.com/v1/search','/preview/geocode').replaceAll('https://api.open-meteo.com/v1/forecast','/preview/forecast').replace("navigator.serviceWorker.register('/sw.js').catch(()=>{})","Promise.resolve()"));
    const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webmanifest':'application/manifest+json'};
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; font-src 'self'"});res.end(bytes);
  } catch(error){send(res,{error:error.message},404);}
});
server.listen(port,'127.0.0.1',()=>console.log(`Scoring fixes preview: http://127.0.0.1:${port} (synthetic data only)`));
