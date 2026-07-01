/* ============================================================
   Progress Tracker v3 — 1プール + 複数目標 + ホームダッシュボード
   ============================================================ */

(() => {
  'use strict';

  // ---- Constants ----
  const THEME_COLORS = [
    '#e8e8e8', '#aaa', '#888', '#bbb', '#ccc', '#999',
    '#ddd', '#777', '#b0b0b0', '#c5c5c5', '#9a9a9a', '#d5d5d5',
  ];
  const GOAL_COLORS = ['#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb923c'];
  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const STORAGE_KEY = 'progressTracker_v2';
  const TREND_DAYS = 14;

  // ---- Utility ----
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
  function formatDateISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function todayISO() { return formatDateISO(new Date()); }

  // ---- Storage / Migration ----
  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return getDefaultState();
  }
  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
  function getDefaultState() {
    return { themes: [], goals: [], history: {}, today: { date: '', count: 0 }, settings: { defaultUnit: '本' }, ui: { view: 'home', goalFilter: null, hideCompleted: false }, rev: 0, lastBackup: 0 };
  }
  function migrateThemes(themes) {
    for (const t of themes) {
      if (!Array.isArray(t.children)) t.children = [];
      if (t.expanded === undefined) t.expanded = true;
      if (t.unit === undefined) t.unit = '';        // '' = 既定の単位を使う
      if (t.archived === undefined) t.archived = false;
      if (t.note === undefined) t.note = '';
      migrateThemes(t.children);
    }
  }
  function migrate(data) {
    // 既に v3
    if (Array.isArray(data.themes) && !data.projects) {
      data.goals = Array.isArray(data.goals) ? data.goals : [];
      data.history = data.history || {};
      data.ui = data.ui || { view: 'home', goalFilter: null };
      if (!('goalFilter' in data.ui)) data.ui.goalFilter = null;
      if (!('hideCompleted' in data.ui)) data.ui.hideCompleted = false;
      data.lastBackup = data.lastBackup || 0;
      data.today = data.today || { date: '', count: 0 };
      if (typeof data.rev !== 'number') data.rev = 0;
      data.settings = data.settings || { defaultUnit: '本' };
      if (!data.settings.defaultUnit) data.settings.defaultUnit = '本';
      migrateThemes(data.themes);
      for (const g of data.goals) {
        g.restDays = g.restDays || [];
        g.holidays = g.holidays || [];
        g.themeIds = g.themeIds || [];
      }
      return data;
    }
    // v2 (projects) -> v3
    const v3 = getDefaultState();
    v3.lastBackup = data.lastBackup || 0;
    if (Array.isArray(data.projects)) {
      const multi = data.projects.length > 1;
      data.projects.forEach((p, idx) => {
        migrateThemes(p.themes || []);
        if (multi) {
          // 複数プロジェクトは科目ごとの親テーマとして残す
          v3.themes.push({
            id: generateId(), name: p.name || ('科目' + (idx + 1)),
            total: 0, completed: 0, children: p.themes || [], expanded: true,
          });
        } else {
          v3.themes.push(...(p.themes || []));
        }
      });
    }
    return v3;
  }

  // ---- State ----
  let state = loadData();
  // 「今日の進捗」を正しく取るため、直近コミット時点の総完了数を保持して差分で集計する
  let committedCompleted = 0;
  function resyncCommitted() { committedCompleted = calcAllProgress(state.themes).completed; }
  // 今日やった分（+/-・スライダーの差分のみ。日付が変わると自動リセット）
  function addToday(delta) {
    if (!delta) return;
    const k = todayISO();
    if (!state.today || state.today.date !== k) state.today = { date: k, count: 0 };
    state.today.count = Math.max(0, state.today.count + delta);
  }
  function todayCount() { return (state.today && state.today.date === todayISO()) ? state.today.count : 0; }
  // 今日やるべき合計＝各目標の「1日のノルマ」の合計
  function todayTargetTotal() {
    let sum = 0;
    for (const g of state.goals) {
      if (!g.deadline) continue;
      const { total, completed } = calcGoalProgress(g);
      const remaining = total - completed;
      if (total === 0 || remaining <= 0) continue;
      const calDays = getDaysRemaining(g.deadline);
      if (calDays !== null && calDays < 0) continue; // 期限超過は除外
      if (isRestToday(g)) continue;                  // 今日は休み
      const hasRest = (g.restDays || []).length > 0;
      const effDays = hasRest ? getWorkingDaysRemaining(g) : calDays;
      if (effDays !== null && effDays > 0) sum += Math.max(1, Math.ceil(remaining / effDays));
    }
    return sum;
  }

  let persistTimer = null;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { saveData(state); persistTimer = null; }, 120);
  }
  function persistNow() {
    if (persistTimer) clearTimeout(persistTimer);
    // データ変更＝版(rev)を更新してクラウド同期へ（有効時のみ）
    state.rev = Date.now();
    saveData(state);
    persistTimer = null;
    scheduleSyncPush();
  }

  // ===========================================================
  //  クラウド同期（Cloud Run + Turso / 合言葉方式・後勝ち）
  // ===========================================================
  const SYNC_API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:8791'
    : 'https://progress-sync-557954279479.asia-northeast1.run.app';
  const SYNC_KEY_LS = 'pt_sync_key';
  function syncKey() { return localStorage.getItem(SYNC_KEY_LS) || ''; }
  function syncEnabled() { return !!syncKey(); }
  let syncPushTimer = null;
  let syncBusy = false;

  function setSyncStatus(text) {
    const el = document.getElementById('sync-status');
    if (el) el.textContent = text;
  }
  function scheduleSyncPush() {
    if (!syncEnabled()) return;
    if (syncPushTimer) clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(syncPush, 1500);
  }
  async function syncPush() {
    if (!syncEnabled()) return;
    try {
      setSyncStatus('同期中…');
      const res = await fetch(SYNC_API + '/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': syncKey() },
        body: JSON.stringify({ data: JSON.stringify(state), updated_at: String(state.rev || 0) }),
      });
      if (!res.ok) throw new Error('push failed ' + res.status);
      setSyncStatus('同期済み ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { setSyncStatus('同期エラー（オフライン？）'); }
  }
  // 起動時などにクラウドと突き合わせ：新しい方を採用
  async function syncPull(opts) {
    if (!syncEnabled() || syncBusy) return;
    syncBusy = true;
    try {
      setSyncStatus('確認中…');
      const res = await fetch(SYNC_API + '/api/state', { headers: { 'X-Sync-Key': syncKey() } });
      if (!res.ok) throw new Error('pull failed ' + res.status);
      const body = await res.json();
      const localRev = state.rev || 0;
      if (body.data) {
        const cloudRev = Number(body.updated_at) || 0;
        if (cloudRev > localRev) {
          const imported = migrate(JSON.parse(body.data));
          state = imported;
          resyncCommitted();
          saveData(state); // revは採用したクラウド値のまま（再pushしない）
          switchView(state.ui.view || 'home');
          setSyncStatus('同期済み（最新を取得）');
          if (opts && opts.toast) showToast('クラウドから最新を取得しました');
          syncBusy = false;
          return;
        } else if (localRev > cloudRev) {
          syncBusy = false;
          await syncPush();
          return;
        }
        setSyncStatus('同期済み（最新）');
      } else {
        // クラウドが空 → ローカルを初回アップロード
        syncBusy = false;
        await syncPush();
        return;
      }
    } catch (e) { setSyncStatus('同期エラー（オフライン？）'); }
    syncBusy = false;
  }
  function enableSync() {
    const input = document.getElementById('sync-key-input');
    const key = (input.value || '').trim();
    if (key.length < 4) { showToast('合言葉は4文字以上にしてください'); return; }
    localStorage.setItem(SYNC_KEY_LS, key);
    renderSyncUI();
    syncPull({ toast: true });
    showToast('クラウド同期を有効にしました');
  }
  function disableSync() {
    if (!confirm('クラウド同期を解除しますか？（この端末のデータは残ります）')) return;
    localStorage.removeItem(SYNC_KEY_LS);
    renderSyncUI();
    showToast('クラウド同期を解除しました');
  }
  function renderSyncUI() {
    const on = syncEnabled();
    const onBox = document.getElementById('sync-on');
    const offBox = document.getElementById('sync-off');
    if (onBox) onBox.style.display = on ? '' : 'none';
    if (offBox) offBox.style.display = on ? 'none' : '';
    if (on) setSyncStatus('同期 有効');
  }

  // ---- Unit helpers ----
  function defaultUnit() { return (state.settings && state.settings.defaultUnit) || '本'; }
  function unitOf(theme) { return theme.unit || defaultUnit(); }

  // ---- Theme tree helpers ----
  function calcThemeProgress(theme) {
    if (theme.children.length === 0) {
      return { total: theme.total || 0, completed: theme.completed || 0 };
    }
    let total = 0, completed = 0;
    for (const child of theme.children) {
      const r = calcThemeProgress(child);
      total += r.total; completed += r.completed;
    }
    return { total, completed };
  }
  function calcAllProgress(themes) {
    let total = 0, completed = 0;
    for (const t of themes) {
      const r = calcThemeProgress(t);
      total += r.total; completed += r.completed;
    }
    return { total, completed };
  }
  function findThemeById(themes, id) {
    for (const t of themes) {
      if (t.id === id) return t;
      const f = findThemeById(t.children, id);
      if (f) return f;
    }
    return null;
  }
  function findThemeAncestors(themes, targetId, ancestors) {
    ancestors = ancestors || [];
    for (const t of themes) {
      if (t.id === targetId) return ancestors;
      if (t.children.length > 0) {
        const r = findThemeAncestors(t.children, targetId, ancestors.concat(t));
        if (r) return r;
      }
    }
    return null;
  }
  function removeThemeById(themes, id) {
    const idx = themes.findIndex(t => t.id === id);
    if (idx !== -1) { themes.splice(idx, 1); return true; }
    for (const t of themes) {
      if (removeThemeById(t.children, id)) return true;
    }
    return false;
  }
  // id を含む兄弟配列を返す（並べ替え用）
  function siblingArrayOf(id, arr) {
    arr = arr || state.themes;
    if (arr.some(t => t.id === id)) return arr;
    for (const t of arr) {
      const r = siblingArrayOf(id, t.children);
      if (r) return r;
    }
    return null;
  }

  // ---- Goals ----
  function getGoalById(id) { return state.goals.find(g => g.id === id) || null; }

  // 目標の進捗（メンバーの葉だけを1回ずつ集計：親選択は配下すべてを含む）
  function calcGoalProgress(goal) {
    const idset = new Set(goal.themeIds);
    let total = 0, completed = 0;
    (function walk(themes, inherited) {
      for (const t of themes) {
        const member = inherited || idset.has(t.id);
        if (t.children.length > 0) walk(t.children, member);
        else if (member) { total += (t.total || 0); completed += (t.completed || 0); }
      }
    })(state.themes, false);
    return { total, completed };
  }
  // ある top-level テーマが目標に1つでも含まれるか（絞り込み表示用）
  function themeHasMember(theme, idset, inherited) {
    const member = inherited || idset.has(theme.id);
    if (theme.children.length === 0) return member;
    if (member) return true;
    return theme.children.some(c => themeHasMember(c, idset, false));
  }

  // ---- Dates / working days ----
  function getDaysRemaining(deadlineStr) {
    if (!deadlineStr) return null;
    const deadline = new Date(deadlineStr + 'T23:59:59');
    return Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24));
  }
  // {deadline, restDays, holidays} を受けて今日含む稼働日数を返す
  function getWorkingDaysRemaining(cfg) {
    if (!cfg.deadline) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(cfg.deadline); end.setHours(0, 0, 0, 0);
    if (end < today) return 0;
    const restDays = cfg.restDays || [];
    const holidays = cfg.holidays || [];
    let count = 0;
    const cur = new Date(today);
    while (cur <= end) {
      const dow = cur.getDay();
      const iso = formatDateISO(cur);
      if (!restDays.includes(dow) && !holidays.includes(iso)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }
  function isRestToday(cfg) {
    const dow = new Date().getDay();
    return (cfg.restDays || []).includes(dow) || (cfg.holidays || []).includes(todayISO());
  }

  // ---- Toast ----
  function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ---- Sync code ----
  function generateSyncCode() {
    try { return 'PT3_' + btoa(unescape(encodeURIComponent(JSON.stringify(state)))); }
    catch (e) { showToast('同期コードの生成に失敗しました'); return ''; }
  }
  function importSyncCode(code) {
    const m = code && code.match(/^PT([23])_(.*)$/s);
    if (!m) throw new Error('無効な同期コードです');
    return JSON.parse(decodeURIComponent(escape(atob(m[2]))));
  }

  // ===========================================================
  //  View routing
  // ===========================================================
  const VIEW_TITLES = { home: 'ホーム', pool: 'リスト', goals: '目標' };

  function switchView(view) {
    state.ui.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.getElementById('view-title').textContent = VIEW_TITLES[view] || '';
    render();
    window.scrollTo(0, 0);
    persist();
  }

  function render() {
    const view = state.ui.view;
    if (view === 'home') renderHome();
    else if (view === 'pool') renderPool();
    else if (view === 'goals') renderGoalsView();
    persist();
  }

  // ===========================================================
  //  HOME
  // ===========================================================
  function renderHome() {
    const { total, completed } = calcAllProgress(state.themes);
    setText('stat-total', total);
    setText('stat-completed', completed);
    setText('stat-remaining', total - completed);

    const percent = total > 0 ? (completed / total) * 100 : 0;
    setText('overall-percent', `${percent.toFixed(1)}%`);
    document.getElementById('overall-bar').style.width = `${percent}%`;
    setText('overall-detail-left', `${completed} / ${total} 完了`);

    const tc = todayCount();
    const tt = todayTargetTotal();
    const valEl = document.getElementById('today-progress-value');
    const trackEl = document.getElementById('today-progress-track');
    const barEl = document.getElementById('today-progress-bar');
    if (tt > 0) {
      const pct = Math.round((tc / tt) * 100);
      valEl.textContent = `${tc} / ${tt}${defaultUnit()} ・ ${pct}%`;
      valEl.classList.toggle('done', tc >= tt);
      trackEl.style.display = '';
      barEl.style.width = Math.min(100, (tc / tt) * 100) + '%';
    } else {
      valEl.textContent = `${tc}${defaultUnit()}`;
      valEl.classList.remove('done');
      trackEl.style.display = 'none';
    }

    renderGoalCards('home-goals', true);
  }

  function renderGoalCards(containerId, compact) {
    const container = document.getElementById(containerId);
    if (state.goals.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-state-icon">◎</div>
        <div class="empty-state-text">目標がまだありません</div>
        <div class="empty-state-sub">「＋ 目標を追加」でCBTやテストの締切を作りましょう</div>
      </div>`;
      return;
    }
    container.innerHTML = state.goals.map(g => goalCardHtml(g, compact)).join('');
  }

  function goalCardHtml(goal, compact) {
    const { total, completed } = calcGoalProgress(goal);
    const remaining = total - completed;
    const percent = total > 0 ? (completed / total) * 100 : 0;
    const calDays = getDaysRemaining(goal.deadline);
    const hasRest = (goal.restDays || []).length > 0;
    const effDays = hasRest ? getWorkingDaysRemaining(goal) : calDays;

    // 締切バッジ
    let dlClass = 'ok', dlText = '締切未設定';
    if (calDays !== null) {
      if (calDays < 0) { dlClass = 'danger'; dlText = `${Math.abs(calDays)}日超過`; }
      else if (calDays === 0) { dlClass = 'danger'; dlText = '今日が締切'; }
      else { dlClass = calDays <= 7 ? 'warn' : 'ok'; dlText = `あと${calDays}日`; }
    }

    // 今日のノルマ
    let paceText = '';
    if (total === 0) paceText = 'テーマ未設定';
    else if (remaining === 0) paceText = '完了 ✓';
    else if (calDays !== null && calDays < 0) paceText = '期限超過';
    else if (isRestToday(goal)) paceText = '今日は休み';
    else if (effDays !== null && effDays > 0) {
      const target = Math.max(1, Math.ceil(remaining / effDays));
      const label = (goal.restDays || []).length > 0 ? '稼働1日' : '1日';
      paceText = `${label} ${target}${defaultUnit()}`;
    } else paceText = `残り${remaining}${defaultUnit()}`;

    const onclick = compact ? `onclick="app.filterByGoal('${goal.id}')"` : `onclick="app.openGoalModal('${goal.id}')"`;
    return `<div class="goal-card" ${onclick} style="--goal-color:${goal.color || '#888'}">
      <div class="goal-card-top">
        <div class="goal-card-name"><span class="goal-dot"></span>${escapeHtml(goal.name)}</div>
        <span class="deadline-badge ${dlClass}">${dlText}</span>
      </div>
      <div class="goal-card-bar"><div class="goal-card-fill" style="width:${percent}%"></div></div>
      <div class="goal-card-detail">
        <span>${completed} / ${total}${defaultUnit()} ・ ${percent.toFixed(0)}%</span>
        <span class="goal-card-pace">${paceText}</span>
      </div>
    </div>`;
  }

  // ===========================================================
  //  GOALS VIEW
  // ===========================================================
  function renderGoalsView() {
    renderGoalCards('goals-list', false);
  }

  function filterByGoal(goalId) {
    state.ui.goalFilter = goalId;
    switchView('pool');
  }
  function clearGoalFilter() {
    state.ui.goalFilter = null;
    render();
  }

  // ===========================================================
  //  POOL (テーマ一覧)
  // ===========================================================
  function renderPool() {
    renderFilterChip();
    renderThemes();
  }

  function renderFilterChip() {
    const row = document.getElementById('filter-chip-row');
    const gid = state.ui.goalFilter;
    const goal = gid ? getGoalById(gid) : null;
    if (!goal) { row.style.display = 'none'; row.innerHTML = ''; return; }
    row.style.display = '';
    row.innerHTML = `<span class="filter-chip" style="--goal-color:${goal.color || '#888'}">
      <span class="goal-dot"></span>絞り込み: ${escapeHtml(goal.name)}
      <button class="filter-chip-clear" onclick="app.clearGoalFilter()" aria-label="解除">✕</button>
    </span>`;
  }

  // テーマが100%完了しているか（未完了だけ表示フィルタ用）
  function isThemeComplete(theme) {
    const { total, completed } = calcThemeProgress(theme);
    return total > 0 && completed >= total;
  }

  function renderThemes() {
    const container = document.getElementById('theme-list');
    const hide = state.ui.hideCompleted;
    let themes = state.themes.filter(t => !t.archived); // 完了済み(アーカイブ)は隠す

    const gid = state.ui.goalFilter;
    const goal = gid ? getGoalById(gid) : null;
    if (goal) {
      const idset = new Set(goal.themeIds);
      themes = themes.filter(t => themeHasMember(t, idset, false));
    }
    if (hide) themes = themes.filter(t => !isThemeComplete(t)); // 未完了だけ表示

    // トグルボタンの状態
    const toggle = document.getElementById('toggle-hide-completed');
    if (toggle) {
      toggle.classList.toggle('active', !!hide);
      toggle.textContent = hide ? '未完了だけ表示中' : '未完了だけ';
    }

    container.innerHTML = '';
    if (themes.length === 0) {
      const sub = hide ? '「未完了だけ」を解除すると完了分も表示されます'
        : goal ? '「目標」タブでテーマを選択してください'
        : '「＋ テーマを追加」または「一括入力」から追加しましょう';
      const txt = hide ? '未完了のテーマはありません 🎉'
        : goal ? 'この目標に紐づくテーマがありません' : 'テーマがまだありません';
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">—</div><div class="empty-state-text">${txt}</div><div class="empty-state-sub">${sub}</div></div>`;
      return;
    }
    let colorIdx = 0;
    themes.forEach(theme => { renderThemeCard(container, theme, 0, colorIdx); colorIdx++; });
  }

  function toggleHideCompleted() {
    state.ui.hideCompleted = !state.ui.hideCompleted;
    persistNow();
    renderThemes();
  }

  function renderThemeCard(container, theme, depth, colorIdx) {
    const { total, completed } = calcThemeProgress(theme);
    const percent = total > 0 ? (completed / total) * 100 : 0;
    const color = THEME_COLORS[colorIdx % THEME_COLORS.length];
    const hasChildren = theme.children.length > 0;
    const isLeaf = !hasChildren;

    const card = document.createElement('div');
    card.className = 'theme-card';

    let h = `<div class="theme-card-header"><div class="theme-card-left">`;
    if (hasChildren) {
      h += `<button class="theme-toggle-btn ${theme.expanded ? 'expanded' : ''}" onclick="app.toggleTheme('${theme.id}')" aria-label="展開/折りたたみ">▶</button>`;
    }
    h += `<div class="theme-color-dot" style="background:${color}"></div>`;
    h += `<span class="theme-name">${escapeHtml(theme.name)}</span>`;
    h += `</div><div class="theme-card-actions">`;
    h += `<button class="btn btn-icon btn-sm" onclick="app.openAddTheme('${theme.id}')" title="サブテーマ追加" aria-label="サブテーマ追加">+</button>`;
    h += `<button class="btn btn-icon btn-sm" onclick="app.editTheme('${theme.id}')" title="編集" aria-label="編集">✎</button>`;
    h += `</div></div>`;

    // 親のみ進捗線
    if (hasChildren) {
      h += `<div class="theme-progress-row">
        <div class="theme-progress-bar"><div class="theme-progress-fill" id="fill-${theme.id}" style="width:${percent}%;background:${color}"></div></div>
        <span class="theme-progress-percent" id="pct-${theme.id}">${percent.toFixed(0)}%</span>
      </div>`;
    }

    if (isLeaf && theme.total > 0) {
      h += `<div class="theme-controls">
        <button class="btn-counter" onclick="app.decrementTheme('${theme.id}')" aria-label="-1">−</button>
        <input type="range" class="theme-slider" id="slider-${theme.id}" min="0" max="${theme.total}" value="${theme.completed}"
          style="--p:${percent};--slider-fill:${color}"
          oninput="app.liveUpdate('${theme.id}',parseInt(this.value))"
          onchange="app.commitUpdate('${theme.id}',parseInt(this.value))" aria-label="進捗">
        <button class="btn-counter" onclick="app.incrementTheme('${theme.id}')" aria-label="+1">＋</button>
        <span class="theme-count-display" id="count-${theme.id}"><strong>${completed}</strong> / ${total}${unitOf(theme)}</span>
      </div>`;
    } else if (hasChildren) {
      h += `<div id="parent-count-${theme.id}" class="parent-count">${completed} / ${total}${defaultUnit()} 完了</div>`;
    }

    if (theme.note) {
      if (/^https?:\/\//i.test(theme.note)) {
        h += `<a class="theme-note is-link" href="${theme.note.replace(/"/g, '%22')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 ${escapeHtml(theme.note)}</a>`;
      } else {
        h += `<div class="theme-note">${escapeHtml(theme.note)}</div>`;
      }
    }

    card.innerHTML = h;

    if (hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = `theme-children ${theme.expanded ? '' : 'collapsed'}`;
      theme.children.forEach((child, ci) => { if (child.archived) return; if (state.ui.hideCompleted && isThemeComplete(child)) return; renderThemeCard(childContainer, child, depth + 1, colorIdx * 10 + ci); });
      const subAddBtn = document.createElement('button');
      subAddBtn.className = 'sub-add-btn';
      subAddBtn.textContent = `＋ ${theme.name}にサブテーマ追加`;
      subAddBtn.addEventListener('click', () => openThemeModal(theme.id, null));
      childContainer.appendChild(subAddBtn);
      card.appendChild(childContainer);
    }
    container.appendChild(card);
  }

  // ---- Live / commit update ----
  function liveUpdateProgress(themeId, value) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    theme.completed = Math.max(0, Math.min(value, theme.total));
    const pct = theme.total > 0 ? (theme.completed / theme.total) * 100 : 0;

    const sliderEl = document.getElementById('slider-' + themeId);
    const countEl = document.getElementById('count-' + themeId);
    if (sliderEl) sliderEl.style.setProperty('--p', pct);
    if (countEl) countEl.innerHTML = '<strong>' + theme.completed + '</strong> / ' + theme.total + unitOf(theme);

    const ancestors = findThemeAncestors(state.themes, themeId) || [];
    for (const anc of ancestors) {
      const ap = calcThemeProgress(anc);
      const apct = ap.total > 0 ? (ap.completed / ap.total) * 100 : 0;
      const af = document.getElementById('fill-' + anc.id);
      const at = document.getElementById('pct-' + anc.id);
      const ac = document.getElementById('parent-count-' + anc.id);
      if (af) af.style.width = apct + '%';
      if (at) at.textContent = Math.round(apct) + '%';
      if (ac) ac.textContent = ap.completed + ' / ' + ap.total + defaultUnit() + ' 完了';
    }
  }

  function commitUpdate(themeId, value) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    theme.completed = Math.max(0, Math.min(value, theme.total));
    const now = calcAllProgress(state.themes).completed;
    addToday(now - committedCompleted); // 今日やった分に反映（先に書き換わっても差分で正しく）
    committedCompleted = now;
    liveUpdateProgress(themeId, theme.completed);
    persistNow();
  }

  function incrementTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme || theme.completed >= theme.total) return;
    theme.completed += 1;
    const slider = document.getElementById('slider-' + themeId);
    if (slider) slider.value = theme.completed;
    commitUpdate(themeId, theme.completed);
  }
  function decrementTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme || theme.completed <= 0) return;
    theme.completed -= 1;
    const slider = document.getElementById('slider-' + themeId);
    if (slider) slider.value = theme.completed;
    commitUpdate(themeId, theme.completed);
  }
  function toggleTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    theme.expanded = !theme.expanded;
    const btn = document.querySelector(`[onclick="app.toggleTheme('${themeId}')"]`);
    if (btn) {
      btn.classList.toggle('expanded', theme.expanded);
      const card = btn.closest('.theme-card');
      const children = card ? card.querySelector(':scope > .theme-children') : null;
      if (children) children.classList.toggle('collapsed', !theme.expanded);
    }
    persist();
  }

  // ===========================================================
  //  Theme CRUD
  // ===========================================================
  function openThemeModal(parentId, editId) {
    const titleEl = document.getElementById('theme-modal-title');
    const nameInput = document.getElementById('theme-name-input');
    const totalInput = document.getElementById('theme-total-input');
    const unitInput = document.getElementById('theme-unit-input');
    const doneInput = document.getElementById('theme-done-input');
    const doneGroup = document.getElementById('theme-done-group');
    const noteInput = document.getElementById('theme-note-input');
    const saveBtn = document.getElementById('theme-save-btn');
    const editActions = document.getElementById('theme-edit-actions');

    if (editId) {
      const theme = findThemeById(state.themes, editId);
      if (!theme) return;
      const isLeaf = theme.children.length === 0;
      titleEl.textContent = 'テーマを編集';
      nameInput.value = theme.name;
      totalInput.value = isLeaf ? theme.total : '';
      totalInput.disabled = !isLeaf;
      unitInput.value = theme.unit || '';
      unitInput.placeholder = defaultUnit();
      doneInput.value = isLeaf ? theme.completed : '';
      doneGroup.style.display = isLeaf ? '' : 'none';   // グループは完了が自動計算
      noteInput.value = theme.note || '';
      saveBtn.setAttribute('data-edit-id', editId);
      saveBtn.removeAttribute('data-parent-id');
      editActions.style.display = '';
    } else {
      titleEl.textContent = parentId ? 'サブテーマを追加' : 'テーマを追加';
      nameInput.value = '';
      totalInput.value = '';
      totalInput.disabled = false;
      unitInput.value = '';
      unitInput.placeholder = defaultUnit();
      doneInput.value = '';
      doneGroup.style.display = '';
      noteInput.value = '';
      saveBtn.removeAttribute('data-edit-id');
      editActions.style.display = 'none';
      if (parentId) saveBtn.setAttribute('data-parent-id', parentId);
      else saveBtn.removeAttribute('data-parent-id');
    }
    showModal('theme-modal');
    setTimeout(() => nameInput.focus(), 150);
  }

  function saveTheme() {
    const nameInput = document.getElementById('theme-name-input');
    const totalInput = document.getElementById('theme-total-input');
    const unitInput = document.getElementById('theme-unit-input');
    const doneInput = document.getElementById('theme-done-input');
    const noteInput = document.getElementById('theme-note-input');
    const saveBtn = document.getElementById('theme-save-btn');
    const editId = saveBtn.getAttribute('data-edit-id');
    const parentId = saveBtn.getAttribute('data-parent-id');

    const name = nameInput.value.trim();
    const total = parseInt(totalInput.value, 10) || 0; // 空欄/0 はグループ
    const unit = unitInput.value.trim();
    const note = noteInput.value.trim();
    const done = Math.max(0, parseInt(doneInput.value, 10) || 0); // 既完了（記録には残さない）
    if (!name) { nameInput.focus(); return; }

    if (editId) {
      const theme = findThemeById(state.themes, editId);
      if (theme) {
        theme.name = name;
        theme.unit = unit;
        theme.note = note;
        if (theme.children.length === 0) {
          theme.total = total;
          theme.completed = Math.min(done, total); // 完了済みを直接セット（履歴は変更しない）
        }
        showToast(`「${name}」を更新しました`);
      }
    } else {
      const newTheme = { id: generateId(), name, total, completed: Math.min(done, total), unit, note, archived: false, children: [], expanded: true };
      if (parentId) {
        const parent = findThemeById(state.themes, parentId);
        if (parent) {
          // 親に本数があってもダミーの同名子は作らない（グループ化するだけ）
          if (parent.total > 0) { parent.total = 0; parent.completed = 0; }
          parent.children.push(newTheme);
          parent.expanded = true;
        }
      } else {
        state.themes.push(newTheme);
      }
      showToast(`「${name}」を追加しました`);
    }
    closeModal('theme-modal');
    resyncCommitted();
    persistNow();
    render();
  }

  // テーマモーダル内からの完了済み/削除
  function archiveTheme() {
    const editId = document.getElementById('theme-save-btn').getAttribute('data-edit-id');
    const theme = findThemeById(state.themes, editId);
    if (!theme) return;
    theme.archived = true;
    closeModal('theme-modal');
    persistNow();
    render();
    showToast(`「${theme.name}」を完了済みにしました`);
  }
  function deleteThemeFromModal() {
    const editId = document.getElementById('theme-save-btn').getAttribute('data-edit-id');
    const theme = findThemeById(state.themes, editId);
    if (!theme) return;
    if (!confirm(`「${theme.name}」を削除しますか？\n（元に戻せません）`)) return;
    removeThemeById(state.themes, editId);
    state.goals.forEach(g => { g.themeIds = g.themeIds.filter(id => id !== editId); });
    closeModal('theme-modal');
    resyncCommitted();
    persistNow();
    render();
    showToast(`「${theme.name}」を削除しました`);
  }

  function deleteTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    if (!confirm(`「${theme.name}」を削除しますか？`)) return;
    removeThemeById(state.themes, themeId);
    // 目標の参照からも除去
    state.goals.forEach(g => { g.themeIds = g.themeIds.filter(id => id !== themeId); });
    resyncCommitted();
    persistNow();
    render();
    showToast(`「${theme.name}」を削除しました`);
  }
  function editTheme(themeId) { openThemeModal(null, themeId); }
  function moveTheme(dir) {
    const id = document.getElementById('theme-save-btn').getAttribute('data-edit-id');
    if (!id) return;
    const arr = siblingArrayOf(id);
    if (!arr) return;
    const i = arr.findIndex(t => t.id === id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) { showToast(dir < 0 ? 'これ以上、上に動かせません' : 'これ以上、下に動かせません'); return; }
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    persistNow();
    render();
    showToast(dir < 0 ? '上に移動しました' : '下に移動しました');
  }

  // ---- Bulk ----
  function collectAllThemes(themes, result, depth) {
    depth = depth || 0;
    for (const t of themes) {
      result.push({ id: t.id, name: t.name, depth });
      if (t.children.length > 0) collectAllThemes(t.children, result, depth + 1);
    }
    return result;
  }
  function openBulkAdd() {
    const select = document.getElementById('bulk-parent-select');
    select.innerHTML = '<option value="">プール直下（トップレベル）</option>';
    collectAllThemes(state.themes, []).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = '  '.repeat(t.depth) + t.name;
      select.appendChild(opt);
    });
    document.getElementById('bulk-textarea').value = '';
    showModal('bulk-modal');
    setTimeout(() => document.getElementById('bulk-textarea').focus(), 150);
  }
  // 全角数字→半角、全角スペース→半角2つ
  function normalizeBulkLine(s) {
    return s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/　/g, '  ');
  }
  // 「テーマ名 + 本数」を柔軟に解釈（タブ/空白/コロン/カンマ/括弧区切り・「12本」「(12)」等）
  function parseNameCount(content) {
    // 1) 末尾の「数字+本/個/コ/つ」→ 本数（区切り無しでも可）
    let m = content.match(/^(.*?)[\s:：,，\(（\[]*(\d+)\s*(?:本|個|コ|つ)\s*[\)）\]]?\s*$/);
    if (m && m[1].trim()) return { name: m[1].replace(/[\s:：,，\(（\[\-—~]+$/, '').trim(), total: parseInt(m[2], 10) };
    // 2) 区切り（空白/コロン/カンマ/括弧）＋末尾数字 → 本数
    m = content.match(/^(.+?)[\s:：,，\(（\[]+(\d+)\s*[\)）\]]?\s*$/);
    if (m) return { name: m[1].trim(), total: parseInt(m[2], 10) };
    // 3) 数字なし → グループ（親テーマ）
    return { name: content.trim(), total: 0 };
  }
  function parseBulkText(text) {
    const root = [];
    const stack = [{ children: root, indent: -1 }];
    for (const raw of text.split('\n')) {
      const norm = normalizeBulkLine(raw).replace(/\t/g, '  ');
      if (!norm.trim()) continue;
      const indent = norm.search(/\S/);
      const { name, total } = parseNameCount(norm.trim());
      if (!name) continue;
      const node = { id: generateId(), name, total, completed: 0, unit: '', note: '', archived: false, children: [], expanded: true };
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push({ children: node.children, indent });
    }
    return root;
  }
  function countThemesRecursive(themes) {
    let c = themes.length;
    for (const t of themes) if (t.children.length > 0) c += countThemesRecursive(t.children);
    return c;
  }
  function saveBulk() {
    const text = document.getElementById('bulk-textarea').value;
    const parentId = document.getElementById('bulk-parent-select').value;
    if (!text.trim()) { showToast('テーマを入力してください'); return; }
    const parsed = parseBulkText(text);
    if (parsed.length === 0) { showToast('有効なテーマが見つかりません'); return; }
    if (parentId) {
      const parent = findThemeById(state.themes, parentId);
      if (parent) {
        // 親に数量があってもダミーの同名子は作らずグループ化するだけ
        if (parent.total > 0) { parent.total = 0; parent.completed = 0; }
        parent.children.push(...parsed);
        parent.expanded = true;
      }
    } else {
      state.themes.push(...parsed);
    }
    closeModal('bulk-modal');
    resyncCommitted();
    persistNow();
    render();
    showToast(`${countThemesRecursive(parsed)}件のテーマを追加しました`);
  }

  // ===========================================================
  //  Goal CRUD
  // ===========================================================
  function openGoalModal(goalId) {
    const titleEl = document.getElementById('goal-modal-title');
    const nameInput = document.getElementById('goal-name-input');
    const deadlineInput = document.getElementById('goal-deadline-input');
    const deleteBtn = document.getElementById('goal-delete-btn');
    const saveBtn = document.querySelector('#goal-modal .btn-primary');

    let selected = [];
    if (goalId) {
      const goal = getGoalById(goalId);
      if (!goal) return;
      titleEl.textContent = '目標を編集';
      nameInput.value = goal.name;
      deadlineInput.value = goal.deadline || '';
      selected = goal.themeIds.slice();
      DAY_NAMES.forEach((_, i) => { const cb = document.getElementById('goal-rest-' + i); if (cb) cb.checked = (goal.restDays || []).includes(i); });
      deleteBtn.style.display = '';
      saveBtn.setAttribute('data-goal-id', goalId);
    } else {
      titleEl.textContent = '目標を追加';
      nameInput.value = '';
      deadlineInput.value = '';
      DAY_NAMES.forEach((_, i) => { const cb = document.getElementById('goal-rest-' + i); if (cb) cb.checked = false; });
      deleteBtn.style.display = 'none';
      saveBtn.removeAttribute('data-goal-id');
    }
    renderGoalThemeSelect(new Set(selected));
    showModal('goal-modal');
    setTimeout(() => nameInput.focus(), 150);
  }

  function renderGoalThemeSelect(selectedSet) {
    const container = document.getElementById('goal-theme-select');
    if (state.themes.length === 0) {
      container.innerHTML = `<p class="form-hint">先に「動画」タブでテーマを追加してください。</p>`;
      return;
    }
    let html = '';
    (function walk(themes, depth, pids) {
      for (const t of themes) {
        const p = calcThemeProgress(t);
        const checked = selectedSet.has(t.id);
        html += `<label class="theme-select-item" style="padding-left:${depth * 18 + 4}px">
          <input type="checkbox" class="goal-theme-cb" value="${t.id}" data-pids="${pids.join(',')}" data-explicit="${checked}" ${checked ? 'checked' : ''} onchange="app.onGoalCbChange(this)">
          <span class="theme-select-name">${escapeHtml(t.name)}</span>
          <span class="theme-select-count">${p.total}${unitOf(t)}</span>
          <span class="theme-select-tag">親で選択中</span>
        </label>`;
        if (t.children.length > 0) walk(t.children, depth + 1, pids.concat(t.id));
      }
    })(state.themes, 0, []);
    container.innerHTML = html;
    refreshGoalSelect();
  }

  // 親が選択されたら配下を「含む（covered）」表示にし、保存対象は最上位の選択ノードだけにする
  function refreshGoalSelect() {
    const cbs = [...document.querySelectorAll('.goal-theme-cb')];
    const explicit = new Set(cbs.filter(c => c.dataset.explicit === 'true').map(c => c.value));
    for (const cb of cbs) {
      const pids = (cb.dataset.pids || '').split(',').filter(Boolean);
      const covered = pids.some(pid => explicit.has(pid));
      const item = cb.closest('.theme-select-item');
      if (covered) { cb.checked = true; cb.disabled = true; item.classList.add('covered'); }
      else { cb.disabled = false; cb.checked = cb.dataset.explicit === 'true'; item.classList.remove('covered'); }
    }
  }
  function onGoalCbChange(cb) { cb.dataset.explicit = cb.checked ? 'true' : 'false'; refreshGoalSelect(); }
  function goalSelectAll() {
    document.querySelectorAll('.goal-theme-cb').forEach(cb => { if (!(cb.dataset.pids || '')) cb.dataset.explicit = 'true'; });
    refreshGoalSelect();
  }
  function goalSelectNone() {
    document.querySelectorAll('.goal-theme-cb').forEach(cb => { cb.dataset.explicit = 'false'; });
    refreshGoalSelect();
  }

  function saveGoal() {
    const saveBtn = document.querySelector('#goal-modal .btn-primary');
    const goalId = saveBtn.getAttribute('data-goal-id');
    const name = document.getElementById('goal-name-input').value.trim();
    const deadline = document.getElementById('goal-deadline-input').value || '';
    if (!name) { document.getElementById('goal-name-input').focus(); return; }

    const restDays = [];
    DAY_NAMES.forEach((_, i) => { const cb = document.getElementById('goal-rest-' + i); if (cb && cb.checked) restDays.push(i); });
    const themeIds = [...document.querySelectorAll('.goal-theme-cb')].filter(cb => cb.checked && !cb.disabled).map(cb => cb.value);

    if (goalId) {
      const goal = getGoalById(goalId);
      if (goal) { goal.name = name; goal.deadline = deadline; goal.restDays = restDays; goal.themeIds = themeIds; }
      showToast(`目標「${name}」を更新しました`);
    } else {
      state.goals.push({
        id: generateId(), name, deadline, restDays, holidays: [], themeIds,
        color: GOAL_COLORS[state.goals.length % GOAL_COLORS.length],
      });
      showToast(`目標「${name}」を追加しました`);
    }
    closeModal('goal-modal');
    persistNow();
    render();
  }

  function deleteGoal() {
    const saveBtn = document.querySelector('#goal-modal .btn-primary');
    const goalId = saveBtn.getAttribute('data-goal-id');
    const goal = getGoalById(goalId);
    if (!goal) return;
    if (!confirm(`目標「${goal.name}」を削除しますか？（動画の視聴記録は消えません）`)) return;
    state.goals = state.goals.filter(g => g.id !== goalId);
    if (state.ui.goalFilter === goalId) state.ui.goalFilter = null;
    closeModal('goal-modal');
    persistNow();
    render();
    showToast(`目標「${goal.name}」を削除しました`);
  }

  // ===========================================================
  //  Sync & Backup
  // ===========================================================
  function openSyncModal() {
    document.getElementById('sync-export-area').value = '';
    document.getElementById('sync-import-area').value = '';
    showModal('sync-modal');
  }
  function generateAndShowSyncCode() {
    document.getElementById('sync-export-area').value = generateSyncCode();
    state.lastBackup = Date.now();
    persistNow();
  }
  function copySyncCode() {
    const area = document.getElementById('sync-export-area');
    if (!area.value) generateAndShowSyncCode();
    navigator.clipboard.writeText(area.value).then(() => showToast('同期コードをコピーしました'))
      .catch(() => { area.select(); document.execCommand('copy'); showToast('同期コードをコピーしました'); });
  }
  function applyImported(imported) {
    state = migrate(imported);
    resyncCommitted();
    persistNow();
    switchView(state.ui.view || 'home');
  }
  function loadSyncCode() {
    const code = document.getElementById('sync-import-area').value.trim();
    if (!code) { showToast('同期コードを貼り付けてください'); return; }
    try {
      const imported = importSyncCode(code);
      closeModal('sync-modal');
      applyImported(imported);
      showToast('データを読み込みました');
    } catch (e) { showToast('無効な同期コードです'); }
  }
  function exportAllJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `progress_tracker_backup_${todayISO()}.json`; a.click();
    URL.revokeObjectURL(url);
    state.lastBackup = Date.now();
    persistNow();
    showToast('バックアップファイルをダウンロードしました');
  }
  function importJSONFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        closeModal('sync-modal');
        applyImported(imported);
        showToast('バックアップから復元しました');
      } catch (err) { showToast('無効なバックアップファイルです'); }
    };
    reader.readAsText(file);
  }
  function handleFileImport() {
    const input = document.getElementById('import-file-input');
    if (input.files.length > 0) importJSONFile(input.files[0]);
  }

  // ===========================================================
  //  Menu / Settings / Archive(完了済み)
  // ===========================================================
  function openMenu() {
    document.getElementById('default-unit-input').value = defaultUnit();
    document.getElementById('sync-key-input').value = '';
    renderSyncUI();
    renderArchiveList();
    showModal('menu-modal');
  }
  function syncNow() { syncPull({ toast: true }); }
  function saveMenu() {
    const u = document.getElementById('default-unit-input').value.trim() || '本';
    state.settings.defaultUnit = u;
    closeModal('menu-modal');
    persistNow();
    render();
    showToast('設定を保存しました');
  }
  function resetAllData() {
    if (!confirm('この端末のテーマ・目標・記録をすべて消して最初の状態に戻します。\n元に戻せません。よろしいですか？')) return;
    if (!confirm('本当にすべて削除しますか？（最終確認）')) return;
    state = getDefaultState();
    committedCompleted = 0;
    state.ui.goalFilter = null;
    closeModal('menu-modal');
    persistNow();
    switchView('home');
    showToast('すべてのデータをリセットしました');
  }
  // ツリーから完了済みのテーマを集める
  function collectArchived(themes, out, trail) {
    for (const t of themes) {
      const path = trail ? trail + ' / ' + t.name : t.name;
      if (t.archived) out.push({ theme: t, path });
      else if (t.children.length) collectArchived(t.children, out, path);
    }
    return out;
  }
  function renderArchiveList() {
    const container = document.getElementById('archive-list');
    const items = collectArchived(state.themes, [], '');
    if (items.length === 0) {
      container.innerHTML = `<p class="archive-empty">完了済みのテーマはありません。</p>`;
      return;
    }
    container.innerHTML = items.map(({ theme, path }) => {
      const { total, completed } = calcThemeProgress(theme);
      const unit = theme.unit || defaultUnit();
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      return `<div class="archive-item">
        <div class="archive-item-main">
          <div class="archive-item-name">${escapeHtml(theme.name)}</div>
          <div class="archive-item-sub">${completed} / ${total}${unit}・${pct}%</div>
        </div>
        <div class="archive-item-actions">
          <button class="btn btn-sm" onclick="app.unarchiveTheme('${theme.id}')">戻す</button>
          <button class="btn btn-sm btn-danger-text" onclick="app.deleteArchivedTheme('${theme.id}')">削除</button>
        </div>
      </div>`;
    }).join('');
  }
  function unarchiveTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    theme.archived = false;
    renderArchiveList();
    persistNow();
    render();
    showToast(`「${theme.name}」を一覧に戻しました`);
  }
  function deleteArchivedTheme(themeId) {
    const theme = findThemeById(state.themes, themeId);
    if (!theme) return;
    if (!confirm(`「${theme.name}」を削除しますか？\n（元に戻せません）`)) return;
    removeThemeById(state.themes, themeId);
    state.goals.forEach(g => { g.themeIds = g.themeIds.filter(id => id !== themeId); });
    renderArchiveList();
    resyncCommitted();
    persistNow();
    render();
    showToast(`「${theme.name}」を削除しました`);
  }

  // ===========================================================
  //  Modal helpers
  // ===========================================================
  function showModal(id) {
    const overlay = document.getElementById(id);
    overlay.classList.add('active');
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(id); };
  }
  function closeModal(id) { document.getElementById(id).classList.remove('active'); }

  // small helper
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(text)) el.textContent = String(text);
  }

  // ---- Keyboard ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    if (e.key === 'Enter' && !e.shiftKey) {
      const modal = document.querySelector('.modal-overlay.active');
      if (modal) {
        const el = document.activeElement;
        if (el && el.tagName === 'INPUT' && el.type !== 'date') {
          e.preventDefault();
          const btn = modal.querySelector('.btn-primary');
          if (btn) btn.click();
        }
      }
    }
  });

  // ===========================================================
  //  Public API
  // ===========================================================
  window.app = {
    switchView,
    filterByGoal, clearGoalFilter, toggleHideCompleted,
    // themes
    openAddTheme: (parentId) => openThemeModal(parentId || null, null),
    saveTheme, editTheme, toggleTheme, archiveTheme, deleteThemeFromModal,
    moveTheme,
    liveUpdate: liveUpdateProgress, commitUpdate, incrementTheme, decrementTheme,
    openBulkAdd, saveBulk,
    // goals
    openGoalModal, saveGoal, deleteGoal,
    onGoalCbChange, goalSelectAll, goalSelectNone,
    // menu / 完了済み
    openMenu, saveMenu, unarchiveTheme, deleteArchivedTheme, resetAllData,
    // cloud sync
    enableSync, disableSync, syncNow,
    // sync
    openSync: openSyncModal, generateSync: generateAndShowSyncCode, copySync: copySyncCode,
    loadSync: loadSyncCode, exportJSON: exportAllJSON, handleFileImport,
    // modal
    closeModal,
  };

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', () => {
    resyncCommitted();
    switchView(state.ui.view || 'home');
    if (syncEnabled()) syncPull({ toast: false });   // 起動時にクラウドと突き合わせ
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        // 新バージョンを検知したら自動で取り込んで一度だけ再読み込み
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'activated' && navigator.serviceWorker.controller && !window.__ptReloaded) {
              window.__ptReloaded = true;
              location.reload();
            }
          });
        });
        reg.update();
      }).catch(() => {});
    }
  });

})();
