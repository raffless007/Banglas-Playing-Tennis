// Focused production fixes. This does not include the mobile redesign.
(() => {
  transportRequest = async function(action, method = 'GET', body, admin = false) {
    const controller = new AbortController(), limit = method === 'GET' ? 20000 : 30000;
    const timeout = setTimeout(() => controller.abort(), limit);
    const endpoint = `${API}?action=${action}${method === 'GET' ? `&ts=${Date.now()}` : ''}`;
    try {
      const response = await fetch(endpoint, {
        method, cache: method === 'GET' ? 'no-store' : undefined, signal: controller.signal,
        headers: { 'content-type':'application/json', ...(playerToken ? {'x-player-session':playerToken} : {}), ...(adminToken && admin ? {authorization:`Bearer ${adminToken}`} : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json) {
        if (response.status === 401 && !admin && !action.startsWith('player-') && action !== 'admin-login') {
          playerToken = null; localStorage.removeItem('bpt-player-token'); renderPlayerChooser(); $('gate').classList.remove('hidden');
        }
        const error = new Error(json?.error || 'The server response could not be confirmed.');
        error.status = response.status;
        error.uncertain = method !== 'GET' && (!json || response.status >= 500);
        throw error;
      }
      return json;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        const failure = new Error(method === 'GET' ? 'Loading is taking longer than expected. Please try again.' : 'The save could not be confirmed. It may have reached the server; checking the latest data is safer than submitting again.');
        failure.uncertain = method !== 'GET'; throw failure;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  function sessionStart(event) {
    const [year,month,day] = event.event_date.split('-').map(Number), [hour,minute,second=0] = startTime(event).split(':').map(Number);
    let utc = Date.UTC(year,month-1,day,hour,minute,second);
    const target = utc;
    // Convert the venue's wall-clock time, including Sydney DST, without
    // relying on the timezone configured on the participant's device.
    for (let pass=0; pass<2; pass++) {
      const parts = new Intl.DateTimeFormat('en-AU',{timeZone:event.timezone||'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(utc));
      const p = Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
      utc += target - Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    }
    return new Date(utc);
  }
  scoringClosesFor = function(event) {
    const opens = sessionStart(event);
    return data.events.filter(row=>row.id!==event.id&&!row.deleted_at&&row.cancellation_status!=='cancelled')
      .map(sessionStart).filter(date=>date>opens).sort((a,b)=>a-b)[0] || new Date(8640000000000000);
  };
  scoringOpenFor = event => !event.deleted_at && event.cancellation_status!=='cancelled' && new Date()>=sessionStart(event) && new Date()<scoringClosesFor(event);
  scoringWindowText = function(event) {
    if (adminToken) return 'Admin can add or correct scores for any week, including closed weeks.';
    if (new Date()<sessionStart(event)) return `Scoring opens at ${startTime(event).slice(0,5)} on match day.`;
    const deadline = scoringClosesFor(event);
    if (deadline.getTime()===8640000000000000) return 'Completed matches can be added until the next scheduled session starts.';
    return `${new Date()>=deadline?'Score entry closed':'Add completed matches until'} ${fmt(deadline,{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:event.timezone||'Australia/Sydney'})}, when the next session starts.`;
  };

  const draftKey = id => `bpt-unsaved-scores:${currentPlayerId}:${id}`;
  const batches = new Map();
  let savingScores = false;
  function rememberDrafts() {
    if (!currentPlayerId || !scoreDraftEventId) return;
    try { localStorage.setItem(draftKey(scoreDraftEventId),JSON.stringify({drafts:scoreDrafts,submissionId:batches.get(scoreDraftEventId)})); } catch { /* Storage can be unavailable in private mode. */ }
  }
  function restoreDrafts(eventId, force = false) {
    if (!eventId || (!force && scoreDraftEventId===eventId)) return false;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(eventId))||'null');
      if (!Array.isArray(saved?.drafts) || !saved.drafts.length) return false;
      scoreDraftEventId=eventId; scoreDrafts=saved.drafts;
      if (saved.submissionId) batches.set(eventId,saved.submissionId);
      return true;
    } catch { return false; }
  }
  const baseScores = renderScores;
  renderScores = function(...args) {
    const previousDraftEventId=scoreDraftEventId;
    restoreDrafts(scoreEventId);
    let result = baseScores(...args);
    if (previousDraftEventId!==scoreEventId && restoreDrafts(scoreEventId,true)) result = baseScores(...args);
    const entry = $('scoreEntry'), event = data.events.find(row=>row.id===scoreEventId);
    entry?.querySelectorAll('input,select').forEach(input=>input.addEventListener('input',()=>{captureDrafts();rememberDrafts()}));
    const help = entry?.querySelector('.match-draft');
    if (help && !entry.querySelector('[data-score-save-help]')) {
      const note = document.createElement('p'); note.className='sub'; note.dataset.scoreSaveHelp='true';
      note.textContent=`${event?scoringWindowText(event):''} For race-to-4 tie-breaks, enter 3–3 plus the tie-break points; a valid winner is saved as 4–3. Unsaved matches stay on this device until confirmed.`;
      help.before(note);
    }
    // The longer window is for entering completed results. Existing live
    // scoring still uses its separate match-day window and controls.
    if (event && !adminToken && new Date()>new Date(eventMoment(event,endTime(event)).getTime()+24*3600000) && $('startLive')) {
      const manual = entry.querySelector('.match-draft')?.parentElement;
      if (manual) for (const child of [...entry.querySelector('.score-entry').children]) { if(child===manual) break; child.classList.add('hidden'); }
    }
    entry?.querySelectorAll('p.sub').forEach(node=>{
      if(node.textContent.includes('24 hours after the session ends')) node.textContent='Participants can add completed matches until the next scheduled session starts. Admin can add or correct them at any time.';
    });
    return result;
  };
  submitScores = async function(eventId) {
    if (savingScores) return;
    captureDrafts(); savingScores=true;
    const authorId=currentPlayerId, storageKey=draftKey(eventId);
    const button=$('saveScores'); if(button){button.disabled=true;button.textContent='Saving…';}
    if(!batches.has(eventId)) batches.set(eventId,crypto.randomUUID());
    rememberDrafts();
    const matches=scoreDrafts.map(d=>({matchType:d.matchType||'doubles',gamesToWin:d.matchType==='singles'?(d.gamesToWin||'4'):'4',teamA:[d.teamA1,...(d.matchType==='singles'?[]:[d.teamA2])].filter(Boolean),teamB:[d.teamB1,...(d.matchType==='singles'?[]:[d.teamB2])].filter(Boolean),gamesA:d.gamesA,gamesB:d.gamesB,tiebreakA:d.tiebreakA,tiebreakB:d.tiebreakB}));
    try {
      const result=await request('score','POST',{eventId,submittedBy:authorId,matches,submissionId:batches.get(eventId)},Boolean(adminToken));
      try { localStorage.removeItem(storageKey); } catch { /* A confirmed save stays confirmed even if storage is unavailable. */ }
      if(currentPlayerId!==authorId)return;
      for(const score of result.scores||[]) if(!data.scores.some(row=>row.id===score.id)) data.scores.push(score);
      batches.delete(eventId); scoreDrafts=[blankDraft()];
      renderScores(); notify(`${result.saved} match${result.saved===1?'':'es'} saved`);
      refresh().catch(()=>notify('Scores saved. The latest table could not refresh yet.'));
    } catch(error) { notify(error.uncertain?'Save not confirmed. Your draft is safe; retrying this unchanged submission will not duplicate scores.':error.message); }
    finally { savingScores=false;const current=$('saveScores');if(current){current.disabled=false;current.textContent=`Save ${scoreDrafts.length} match${scoreDrafts.length===1?'':'es'}`;} }
  };

  const baseAdminScores=renderAdminScores;
  renderAdminScores=function(...args){
    const result=baseAdminScores(...args), panel=$('adminScoresPanel');
    if(adminToken&&panel&&!panel.querySelector('#adminAddScore')){
      const row=document.createElement('div');row.className='admin-add-score-row';
      const button=document.createElement('button');button.id='adminAddScore';button.className='primary';button.type='button';button.textContent='Add New Score';
      button.onclick=()=>{rememberDrafts();scoreEventId=adminScoreEventId;scoreSubtab='scores';go('scores');document.querySelector('[data-score-save-help]')?.scrollIntoView({block:'start'});};
      row.append(button);panel.querySelector('#adminScoreWeek')?.closest('label').after(row);
    }
    return result;
  };

  const baseAdmin=renderAdmin;
  renderAdmin=function(...args){
    const result=baseAdmin(...args), lock=$('adminLock');
    const existing=$('profileAdminUnlock');
    if(!data.profileAdmin||!playerToken){existing?.remove();return result;}
    if(!adminToken&&lock&&!existing){
      const button=document.createElement('button');button.id='profileAdminUnlock';button.type='button';button.className='primary';button.textContent='Continue with my Admin profile';
      button.onclick=async()=>{
        button.disabled=true;
        try{
          const result=await request('admin-profile-login','POST',{playerId:currentPlayerId});
          adminToken=result.token;adminLastActivity=Date.now();adminSessionStore.setItem('bpt-admin-token',adminToken);adminSessionStore.setItem(ADMIN_ACTIVITY_KEY,String(adminLastActivity));sessionWarnings.admin=false;ensureSessionTimer();adminDataLoading=true;renderAdmin();
          await Promise.all([loadAdminData(),refresh()]);
        }catch(error){notify(error.message);}finally{adminDataLoading=false;button.disabled=false;renderAdmin();}
      };
      lock.prepend(button);
    }
    return result;
  };

  adminCall=async function(action,body,message){
    if(adminBusy)return;adminBusy=true;
    try{
      const result=await request(action,'POST',body,true);adminDirty=false;
      if(result.event){const index=data.events.findIndex(row=>row.id===result.event.id);if(index>=0)data.events[index]=result.event;}
      if(result.score){const index=data.scores.findIndex(row=>row.id===result.score.id);if(index>=0)data.scores[index]=result.score;}
      notify(message);
      const updates=await Promise.allSettled([refresh(),loadAdminData()]);
      if(updates.some(update=>update.status==='rejected'))notify(`${message}. Some updated data is still loading; the save was confirmed.`);
      if(!adminDirty)renderAdmin();
    }catch(error){
      if(error.status===401||error.message.includes('expired'))expireAdminSession(false);
      notify(error.message);
      if(error.uncertain)refresh().catch(()=>{});
    }finally{adminBusy=false;}
  };

  const basePlay=renderPlay;
  renderPlay=function(...args){const result=basePlay(...args);if(eoiPending.has(`${upcoming()[selected]?.id}:${currentPlayerId}`))document.querySelectorAll('[data-response]').forEach(button=>button.disabled=true);return result;};
  submitEoi=async function(eventId,status){
    const playerId=currentPlayerId,key=`${eventId}:${playerId}`;if(eoiPending.has(key))return;
    const previous=data.eois.find(row=>row.event_id===eventId&&row.player_id===playerId);
    eoiPending.add(key);upsertLocalEoi(eventId,playerId,status);renderPlay();notify('Saving response…');
    try{
      const result=await request('eoi','POST',{eventId,playerId,status});
      if(currentPlayerId!==playerId)return;
      upsertLocalEoi(eventId,playerId,status,result.waitlisted?(result.waitlistPosition||1):null);notify(result.waitlisted?'You are on the waitlist for this week.':'Response saved');refresh().catch(()=>{});
    }catch(error){
      if(error.uncertain){
        try{
          const state=await request('eoi-state'),row=state.eois?.find(item=>item.event_id===eventId&&item.player_id===playerId);
          if(currentPlayerId!==playerId)return;
          if(row?.status===status){upsertLocalEoi(eventId,playerId,row.status,row.waitlist_position);notify('Response saved and confirmed.');}
          else notify('Response is not confirmed yet. Refresh to check before submitting again.');
        }catch{notify('Connection interrupted. Your response is not confirmed yet; refresh when connected.');}
      }else{
        if(currentPlayerId!==playerId)return;
        if(previous)upsertLocalEoi(eventId,playerId,previous.status,previous.waitlist_position);
        else data.eois=data.eois.filter(row=>!(row.event_id===eventId&&row.player_id===playerId));
        notify(error.message);
      }
    }finally{eoiPending.delete(key);renderPlay();}
  };
})();
