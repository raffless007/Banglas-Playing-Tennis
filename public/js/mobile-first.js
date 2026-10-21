/* Presentation enhancements over the existing app. No data requests here. */
(() => {
  const paths = {
    play:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
    scores:'M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7',
    profiles:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    media:'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l5-5 7 7 3-3 3 3M16 8h.01',
    payments:'M3 6h18v14H3ZM3 10h18M7 15h3M17 3v3',
    admin:'m12 3 8 4v5c0 4-4 7-8 9-4-2-8-5-8-9V7ZM9 12l2 2 4-4',
    live:'M9 4v16l12-8ZM3 6v12',
    directions:'m12 2 10 10-10 10L2 12ZM8 15v-4h8M13 8l3 3-3 3',
    calendar:'M4 5h16v16H4ZM8 2v6M16 2v6M4 11h16M8 15h2M14 15h2',
    chevron:'m8 10 4 4 4-4',
    upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
    bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  };
  const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name] || paths.play}"/></svg>`;
  const labelButton = (button, name, text) => {
    button.innerHTML = `${icon(name)}<span>${text}</span>`;
  };
  document.querySelector('.mobile')?.setAttribute('aria-label', 'Main navigation');
  document.querySelector('.nav')?.setAttribute('aria-label', 'Main navigation');
  document.querySelectorAll('.mobile [data-page]').forEach(button => labelButton(button, button.dataset.page, button.textContent.trim()));
  const bell = document.getElementById('notifications');
  if (bell) {
    bell.innerHTML = icon('bell');
    bell.setAttribute('aria-label', 'Notifications');
    bell.title = 'Notifications';
  }
  const applyCurrentPage = () => document.querySelectorAll('[data-page]').forEach(button => {
    if (button.classList.contains('active')) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const originalSetActivePage = setActivePage;
  setActivePage = function(page) { originalSetActivePage(page); applyCurrentPage(); };
  applyCurrentPage();
  const originalRenderActivePage = renderActivePage;
  renderActivePage = function(...args) {
    const started = performance.now();
    try { return originalRenderActivePage(...args); }
    finally { window.BPTPerformance?.recordRender(activePage, performance.now() - started); }
  };
  const originalSettings = renderSettings;
  renderSettings = function(...args) {
    const result = originalSettings(...args), panel = document.getElementById('settingsPanel');
    if (panel && !panel.querySelector('#copyPerformanceReport')) {
      const card = document.createElement('article'); card.className = 'card admincard';
      card.innerHTML = '<p class="eyebrow">APP PERFORMANCE</p><h3>Loading diagnostics</h3><p class="sub">Copy recent loading and screen timings to help investigate delays. The report contains no profile details, PINs or login tokens.</p><div class="actions"><button id="copyPerformanceReport" class="secondary" type="button">Copy timing report</button></div>';
      card.querySelector('button').onclick = () => copyText(JSON.stringify(window.BPTPerformance?.snapshot() || {}, null, 2), 'Timing report copied');
      panel.append(card);
    }
    return result;
  };
  const originalAdminEvents = renderAdminEvents;
  renderAdminEvents = function(...args) {
    const result = originalAdminEvents(...args), panel = document.getElementById('eventsPanel');
    const rows = [...(panel?.querySelectorAll('[data-admin-event]') || [])];
    if (rows.length && !panel.querySelector('#mobileAdminEvent')) {
      const label = document.createElement('label'); label.className = 'mobile-admin-event-picker';
      const caption = document.createElement('span'); caption.className = 'label'; caption.textContent = 'Session';
      const select = document.createElement('select'); select.id = 'mobileAdminEvent'; select.className = 'control';
      for (const row of rows) {
        const option = document.createElement('option'); option.value = row.dataset.adminEvent;
        option.textContent = `${row.querySelector('strong')?.textContent} — ${row.querySelector('small')?.textContent.split('·')[0].trim()}`;
        option.selected = row.classList.contains('active'); select.append(option);
      }
      select.onchange = () => { adminDirty = false; rows.find(row => row.dataset.adminEvent === select.value)?.click(); };
      label.append(caption, select); panel.prepend(label);
    }
    return result;
  };

  const playHero = document.querySelector('#playPage .hero');
  if (playHero) {
    playHero.querySelector('h1').textContent = 'Your next session';
    playHero.querySelector('.sub').textContent = 'Pick a week. Lock in your spot.';
  }
  function enhancePlay() {
    const tools = document.getElementById('eventQuickActions');
    const side = document.querySelector('#playPage .side');
    if (tools && side) {
      tools.className = 'quick-tools';
      tools.setAttribute('aria-label', 'Session shortcuts');
      const directions = document.getElementById('directionsBtn');
      const calendar = document.getElementById('itineraryBtn');
      if (directions) labelButton(directions, 'directions', 'Directions');
      if (calendar) labelButton(calendar, 'calendar', 'Calendar');
      for (const [target, graphic, text, leaderboard] of [
        ['scores', 'live', 'Live scoring', false],
        ['payments', 'payments', 'Payments', false],
        ['scores', 'scores', 'Leaderboard', true],
        ['media', 'media', 'Photos', false],
      ]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary';
        labelButton(button, graphic, text);
        button.onclick = () => {
          if (target === 'scores') {
            scoreSubtab = leaderboard ? 'leaderboard' : 'scores';
            if (!leaderboard) scoreEventId = upcoming()[selected]?.id || scoreEventId;
          }
          go(target);
        };
        tools.insertBefore(button, directions || calendar || null);
      }
      side.prepend(tools);
    }
    enhanceWeather();
  }
  function enhanceWeather() {
    const weather = document.getElementById('weatherCard');
    if (!weather || weather.querySelector('.weather-toggle')) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'weather-toggle'; button.innerHTML = icon('chevron');
    const update = () => {
      const expanded = weather.classList.contains('weather-expanded');
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', expanded ? 'Hide weather details' : 'Show weather details');
    };
    button.onclick = () => { weather.classList.toggle('weather-expanded'); update(); };
    update(); weather.append(button);
  }
  const basePlay = renderPlay;
  renderPlay = function(...args) { const result = basePlay(...args); enhancePlay(); return result; };
  const weather = document.getElementById('weatherCard');
  if (weather) new MutationObserver(enhanceWeather).observe(weather, { childList: true });

  let manualExpanded = false;
  function enhanceScores() {
    const view = document.getElementById('scoreView');
    view?.classList.toggle('scoring-ready', Boolean(document.getElementById('startLive') || document.getElementById('liveServer')));
    view?.classList.toggle('has-live-controls', Boolean(document.getElementById('liveServer')));
    const singles = document.querySelector('#scoreEntry .live-scoreboard .eyebrow')?.textContent.includes('SINGLES');
    if (singles) {
      const a = document.querySelector('[data-live-point="a"]'), b = document.querySelector('[data-live-point="b"]');
      if (a) a.textContent = '+ Point Player 1';
      if (b) b.textContent = '+ Point Player 2';
    }
    const help = view?.querySelector('.score-help');
    if (help && !help.closest('details')) {
      const disclosure = document.createElement('details'); disclosure.className = 'scoring-rules';
      const summary = document.createElement('summary'); summary.textContent = 'Scoring rules';
      help.before(disclosure); disclosure.append(summary, help);
    }
    const marker = [...document.querySelectorAll('#scoreEntry .eyebrow')].find(node => node.textContent.trim() === 'MANUAL BACKUP');
    if (marker && !marker.closest('details')) {
      const group = marker.parentElement, disclosure = document.createElement('details'); disclosure.className = 'manual-backup';
      const summary = document.createElement('summary'); summary.textContent = 'Enter a completed match';
      disclosure.append(summary, ...group.childNodes); group.append(disclosure);
      disclosure.open = manualExpanded; disclosure.ontoggle = () => { manualExpanded = disclosure.open; };
    }
  }
  const baseScores = renderScores;
  renderScores = function(...args) { const result = baseScores(...args); enhanceScores(); return result; };
  const baseLiveCall = liveCall;
  liveCall = async function(action, ...args) {
    const result = await baseLiveCall(action, ...args);
    if (action === 'live-start' && document.getElementById('liveServer')) document.getElementById('scoreEntry')?.scrollIntoView({ block:'start', behavior:'auto' });
    return result;
  };

  const mediaPage = document.getElementById('mediaPage');
  const mediaHero = mediaPage?.querySelector('.hero');
  if (mediaHero) {
    const button = document.createElement('button'); button.type = 'button';
    button.id = 'toggleMediaUpload'; button.className = 'secondary'; labelButton(button, 'upload', 'Upload');
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'mediaUploadForm');
    const form = mediaPage.querySelector('.media-upload'); if (form) form.id = 'mediaUploadForm';
    button.onclick = () => {
      const open = mediaPage.classList.toggle('upload-open'); button.setAttribute('aria-expanded', String(open));
      if (open) document.getElementById('mediaTitle')?.focus({ preventScroll: true });
    };
    mediaHero.querySelector('.live')?.remove(); mediaHero.append(button);
  }
  // The app may have already painted an identity-matched cache before this
  // script loaded. Reuse it; the existing server validation still controls
  // removal of the startup overlay and every protected mutation.
  if (typeof data !== 'undefined' && data.events?.length) {
    if (activePage === 'play') enhancePlay();
    if (activePage === 'scores') enhanceScores();
  }
})();
