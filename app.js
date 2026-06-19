/* ============================================================
   Progress Tracker — Application Logic (Optimized)
   ============================================================ */

(() => {
  'use strict';

  // ---- Constants ----
  const THEME_COLORS = [
    '#e8e8e8', '#aaa', '#888', '#bbb',
    '#ccc', '#999', '#ddd', '#777',
    '#b0b0b0', '#c5c5c5', '#9a9a9a', '#d5d5d5',
  ];
  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const STORAGE_KEY = 'progressTracker_v2';
  const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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

  // ---- Storage ----
  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return migrateData(JSON.parse(raw));
      const v1 = localStorage.getItem('progressTracker_v1');
      if (v1) {
        const data = migrateData(JSON.parse(v1));
        localStorage.removeItem('progressTracker_v1');
        return data;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function migrateData(data) {
    if (!data.lastBackup) data.lastBackup = 0;
    for (const project of data.projects) {
      if (!project.restDays) project.restDays = [];
      if (!project.holidays) project.holidays = [];
      migrateThemes(project.themes);
    }
    return data;
  }

  function migrateThemes(themes) {
    for (const t of themes) {
      if (!Array.isArray(t.children)) t.children = [];
      if (t.expanded === undefined) t.expanded = true;
      migrateThemes(t.children);
    }
  }

  function getDefaultProject() {
    return {
      id: generateId(),
      name: '新しいプロジェクト',
      deadline: '',
      restDays: [],
      holidays: [],
      themes: [],
      createdAt: Date.now(),
    };
  }

  function getDefaultState() {
    const p = getDefaultProject();
    return { projects: [p], activeProjectId: p.id, lastBackup: 0 };
  }

  // ---- State ----
  let state = loadData() || getDefaultState();

  function getActiveProject() {
    return state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
  }

  // Debounced persist to avoid excessive localStorage writes
  let persistTimer = null;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { saveData(state); persistTimer = null; }, 100);
  }
  function persistNow() {
    if (persistTimer) clearTimeout(persistTimer);
    saveData(state);
    persistTimer = null;
  }

  // ---- Theme Tree Helpers ----
  function calcThemeProgress(theme) {
    if (theme.children.length === 0) {
      return { total: theme.total || 0, completed: theme.completed || 0 };
    }
    let total = 0, completed = 0;
    for (const child of theme.children) {
      const r = calcThemeProgress(child);
      total += r.total;
      completed += r.completed;
    }
    return { total, completed };
  }

  function calcAllProgress(themes) {
    let total = 0, completed = 0;
    for (const t of themes) {
      const r = calcThemeProgress(t);
      total += r.total;
      completed += r.completed;
    }
    return { total, completed };
  }

  function findThemeById(themes, id) {
    for (const t of themes) {
      if (t.id === id) return t;
      const found = findThemeById(t.children, id);
      if (found) return found;
    }
    return null;
  }

  function findThemeAncestors(themes, targetId, ancestors) {
    ancestors = ancestors || [];
    for (const t of themes) {
      if (t.id === targetId) return ancestors;
      if (t.children.length > 0) {
        const result = findThemeAncestors(t.children, targetId, ancestors.concat(t));
        if (result) return result;
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

  // ---- Date & Working Days ----
  function getDaysRemaining(deadlineStr) {
    if (!deadlineStr) return null;
    const deadline = new Date(deadlineStr + 'T23:59:59');
    const now = new Date();
    return Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
  }

  function getWorkingDaysRemaining(project) {
    if (!project.deadline) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(project.deadline);
    end.setHours(0, 0, 0, 0);
    if (end < today) return 0;

    let count = 0;
    const cur = new Date(today);
    while (cur <= end) {
      const dow = cur.getDay();
      const iso = formatDateISO(cur);
      if (!project.restDays.includes(dow) && !project.holidays.includes(iso)) {
        count++;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return count;
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

  // ===========================================================
  //  Sync Code
  // ===========================================================
  function generateSyncCode() {
    try {
      const json = JSON.stringify(state);
      return 'PT2_' + btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      showToast('同期コードの生成に失敗しました');
      return '';
    }
  }

  function importSyncCode(code) {
    if (!code || !code.startsWith('PT2_')) throw new Error('無効な同期コードです');
    const json = decodeURIComponent(escape(atob(code.slice(4))));
    return JSON.parse(json);
  }

  // ===========================================================
  //  Render — Optimized with partial updates
  // ===========================================================
  function render() {
    const project = getActiveProject();
    renderProjectTabs();
    renderHeader(project);
    renderBackupReminder();
    updateStatsDOM(project);
    updateOverallProgressDOM(project);
    updateTodayDOM(project);
    renderThemes(project);
    persist();
  }

  function renderProjectTabs() {
    const container = document.getElementById('project-tabs');
    container.innerHTML = '';

    state.projects.forEach(p => {
      const { total, completed } = calcAllProgress(p.themes);
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      const tab = document.createElement('button');
      tab.className = `project-tab ${p.id === state.activeProjectId ? 'active' : ''}`;
      tab.innerHTML = `
        <span>${escapeHtml(p.name)}</span>
        <span class="project-tab-progress">${pct}%</span>
      `;

      if (state.projects.length > 1) {
        const del = document.createElement('span');
        del.className = 'project-tab-delete';
        del.textContent = '✕';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteProject(p.id); });
        tab.appendChild(del);
      }

      tab.addEventListener('click', () => {
        state.activeProjectId = p.id;
        render();
      });
      container.appendChild(tab);
    });

    const addTab = document.createElement('button');
    addTab.className = 'project-tab project-tab-add';
    addTab.textContent = '＋';
    addTab.title = '新しいプロジェクト';
    addTab.addEventListener('click', () => {
      const np = getDefaultProject();
      state.projects.push(np);
      state.activeProjectId = np.id;
      render();
      openSettingsModal();
    });
    container.appendChild(addTab);
  }

  function renderHeader(project) {
    document.getElementById('project-name').textContent = project.name;
    document.title = `${project.name} — 進捗トラッカー`;
  }

  function renderBackupReminder() {
    const container = document.getElementById('backup-reminder');
    const hasData = state.projects.some(p => p.themes.length > 0);
    // 初めてデータができた時点で7日カウントを開始する（初日からは催促しない）
    if (hasData && !state.lastBackup) {
      state.lastBackup = Date.now();
      persist();
    }
    const elapsed = Date.now() - (state.lastBackup || 0);
    if (elapsed > BACKUP_INTERVAL_MS && hasData) {
      container.innerHTML = `
        <span class="backup-reminder-text">最後のバックアップから7日以上経過しています</span>
        <div class="backup-reminder-actions">
          <button class="btn btn-sm" onclick="app.openSync()">バックアップ</button>
          <button class="btn btn-sm" onclick="app.dismissBackup()">後で</button>
        </div>
      `;
      container.style.display = '';
    } else {
      container.style.display = 'none';
    }
  }

  // --- Stats (lightweight DOM update, no innerHTML rebuild) ---
  function updateStatsDOM(project) {
    const { total, completed } = calcAllProgress(project.themes);
    const remaining = total - completed;
    const workingDays = getWorkingDaysRemaining(project);
    const calendarDays = getDaysRemaining(project.deadline);

    setTextIfChanged('stat-total', total);
    setTextIfChanged('stat-completed', completed);
    setTextIfChanged('stat-remaining', remaining);

    const perDayEl = document.getElementById('stat-perday');
    const perDaySubEl = document.getElementById('stat-perday-sub');

    const hasRestConfig = project.restDays.length > 0 || project.holidays.length > 0;
    const effectiveDays = hasRestConfig ? workingDays : calendarDays;
    const daysLabel = hasRestConfig ? '稼働日' : '日';

    if (effectiveDays !== null && effectiveDays > 0 && remaining > 0) {
      const perDay = (remaining / effectiveDays).toFixed(1);
      setTextIfChanged(perDayEl, `${perDay}本/日`);
      const cls = 'stat-value' + (perDay > 10 ? ' red' : perDay > 5 ? ' amber' : ' green');
      if (perDayEl.className !== cls) perDayEl.className = cls;
      setTextIfChanged(perDaySubEl, `残り${effectiveDays}${daysLabel}`);
    } else if (calendarDays !== null && calendarDays <= 0 && remaining > 0) {
      setTextIfChanged(perDayEl, '期限超過');
      if (perDayEl.className !== 'stat-value red') perDayEl.className = 'stat-value red';
      setTextIfChanged(perDaySubEl, `${Math.abs(calendarDays)}日超過`);
    } else if (remaining === 0 && total > 0) {
      setTextIfChanged(perDayEl, '完了');
      if (perDayEl.className !== 'stat-value green') perDayEl.className = 'stat-value green';
      setTextIfChanged(perDaySubEl, '');
    } else {
      setTextIfChanged(perDayEl, '—');
      if (perDayEl.className !== 'stat-value') perDayEl.className = 'stat-value';
      setTextIfChanged(perDaySubEl, project.deadline ? `残り${calendarDays ?? '?'}日` : '締切未設定');
    }
  }

  // --- Overall Progress (lightweight DOM update) ---
  function updateOverallProgressDOM(project) {
    const { total, completed } = calcAllProgress(project.themes);
    const percent = total > 0 ? (completed / total) * 100 : 0;

    setTextIfChanged('overall-percent', `${percent.toFixed(1)}%`);

    const bar = document.getElementById('overall-bar');
    const newWidth = `${percent}%`;
    if (bar.style.width !== newWidth) bar.style.width = newWidth;

    setTextIfChanged('overall-detail-left', `${completed} / ${total} 完了`);

    const calDays = getDaysRemaining(project.deadline);
    const badge = document.getElementById('overall-deadline-badge');
    if (project.deadline) {
      let cls = 'ok';
      if (calDays <= 0) cls = 'danger';
      else if (calDays <= 7) cls = 'warn';
      const newClass = `deadline-badge ${cls}`;
      if (badge.className !== newClass) badge.className = newClass;
      const text = calDays > 0 ? `締切まで ${calDays}日` : calDays === 0 ? '今日が締切' : `${Math.abs(calDays)}日超過`;
      setTextIfChanged(badge, text);
      if (badge.style.display === 'none') badge.style.display = '';
    } else {
      if (badge.style.display !== 'none') badge.style.display = 'none';
    }
  }

  // --- 今日の目標（締切が設定されている時のみ表示） ---
  function updateTodayDOM(project) {
    const card = document.getElementById('today-card');
    const { total, completed } = calcAllProgress(project.themes);

    // 締切なし or テーマなしの時は非表示
    if (!project.deadline || total === 0) {
      if (card.style.display !== 'none') card.style.display = 'none';
      return;
    }

    // 今日の起点(base)を記録。日付が変わったらリセット → 今日の完了数 = 現在の完了数 - base
    const todayKey = formatDateISO(new Date());
    if (!project.daily || project.daily.date !== todayKey) {
      project.daily = { date: todayKey, base: completed };
      persist();
    }
    const todayDone = Math.max(0, completed - project.daily.base);
    const remaining = total - completed;

    const calDays = getDaysRemaining(project.deadline);
    const hasRestConfig = project.restDays.length > 0 || project.holidays.length > 0;
    const effectiveDays = hasRestConfig ? getWorkingDaysRemaining(project) : calDays;
    const dow = new Date().getDay();
    const isRestToday = project.restDays.includes(dow) || project.holidays.includes(todayKey);

    let statusText, statusClass, barPct, leftText, rightText;

    if (remaining === 0) {
      statusText = '全完了 ✓'; statusClass = 'done'; barPct = 100;
      leftText = `今日 ${todayDone}本`; rightText = '全テーマ完了';
    } else if (calDays !== null && calDays < 0) {
      statusText = '期限超過'; statusClass = 'danger'; barPct = 0;
      leftText = `今日 ${todayDone}本`; rightText = `${Math.abs(calDays)}日超過・残り${remaining}本`;
    } else if (isRestToday) {
      statusText = '今日は休み'; statusClass = 'rest'; barPct = todayDone > 0 ? 100 : 0;
      leftText = todayDone > 0 ? `今日 ${todayDone}本（前倒し）` : '目標なし';
      rightText = `残り${remaining}本 / 締切まで${calDays}日`;
    } else {
      const target = Math.max(1, Math.ceil(remaining / Math.max(1, effectiveDays)));
      const todayLeft = Math.max(0, target - todayDone);
      barPct = Math.min(100, (todayDone / target) * 100);
      if (todayLeft === 0) {
        statusText = '今日のノルマ達成 ✓'; statusClass = 'done';
      } else {
        statusText = `あと ${todayLeft}本`;
        statusClass = todayLeft > 10 ? 'danger' : todayLeft > 5 ? 'warn' : '';
      }
      leftText = `今日 ${todayDone} / ${target}本`;
      rightText = `残り${remaining}本 / 締切まで${calDays}日`;
    }

    if (card.style.display === 'none') card.style.display = '';
    setTextIfChanged('today-status', statusText);
    const statusEl = document.getElementById('today-status');
    const sc = ('today-status ' + statusClass).trim();
    if (statusEl.className !== sc) statusEl.className = sc;
    const bar = document.getElementById('today-bar');
    const w = barPct + '%';
    if (bar.style.width !== w) bar.style.width = w;
    setTextIfChanged('today-detail-left', leftText);
    setTextIfChanged('today-detail-right', rightText);
  }

  // Micro-optimization: avoid textContent set if unchanged (prevents reflow)
  function setTextIfChanged(elOrId, text) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    const str = String(text);
    if (el.textContent !== str) el.textContent = str;
  }

  // ===========================================================
  //  Theme Rendering (recursive)
  // ===========================================================
  function renderThemes(project) {
    const container = document.getElementById('theme-list');
    container.innerHTML = '';

    if (project.themes.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">—</div>
          <div class="empty-state-text">テーマがまだありません</div>
          <div class="empty-state-sub">「＋ テーマを追加」ボタンからテーマを追加しましょう</div>
        </div>
      `;
      return;
    }

    let colorIdx = 0;
    project.themes.forEach(theme => {
      renderThemeCard(container, theme, 0, colorIdx);
      colorIdx++;
    });
  }

  function renderThemeCard(container, theme, depth, colorIdx) {
    const { total, completed } = calcThemeProgress(theme);
    const percent = total > 0 ? (completed / total) * 100 : 0;
    const color = THEME_COLORS[colorIdx % THEME_COLORS.length];
    const hasChildren = theme.children.length > 0;
    const isLeaf = !hasChildren;

    const card = document.createElement('div');
    card.className = 'theme-card';

    // Header
    let headerHtml = `<div class="theme-card-header"><div class="theme-card-left">`;
    if (hasChildren) {
      headerHtml += `<button class="theme-toggle-btn ${theme.expanded ? 'expanded' : ''}" 
        onclick="app.toggleTheme('${theme.id}')" aria-label="展開/折りたたみ">▶</button>`;
    }
    headerHtml += `<div class="theme-color-dot" style="background:${color}"></div>`;
    headerHtml += `<span class="theme-name">${escapeHtml(theme.name)}</span>`;
    headerHtml += `</div><div class="theme-card-actions">`;
    headerHtml += `<button class="btn btn-icon btn-sm" onclick="app.openAddTheme('${theme.id}')" title="サブテーマ追加" aria-label="サブテーマ追加">+</button>`;
    headerHtml += `<button class="btn btn-icon btn-sm" onclick="app.editTheme('${theme.id}')" title="編集" aria-label="編集">✎</button>`;
    headerHtml += `<button class="btn btn-icon btn-sm btn-danger" onclick="app.deleteTheme('${theme.id}')" title="削除" aria-label="削除">×</button>`;
    headerHtml += `</div></div>`;

    // Progress bar — 親テーマのみ表示（葉テーマはスライダーが進捗線を兼ねるので二重線にしない）
    if (hasChildren) {
      headerHtml += `<div class="theme-progress-row">
        <div class="theme-progress-bar"><div class="theme-progress-fill" id="fill-${theme.id}" style="width:${percent}%;background:${color}"></div></div>
        <span class="theme-progress-percent" id="pct-${theme.id}">${percent.toFixed(0)}%</span>
      </div>`;
    }

    // Theme-level deadline & pace
    const project = getActiveProject();
    const themeDeadline = theme.deadline;
    const remaining = total - completed;
    if (themeDeadline && remaining > 0) {
      const calDays = getDaysRemaining(themeDeadline);
      const hasRest = project.restDays.length > 0 || project.holidays.length > 0;
      const wDays = hasRest ? getWorkingDaysRemaining({ deadline: themeDeadline, restDays: project.restDays, holidays: project.holidays }) : calDays;
      const effectDays = hasRest ? wDays : calDays;
      if (effectDays !== null && effectDays > 0) {
        const pace = (remaining / effectDays).toFixed(1);
        const paceClass = pace > 10 ? 'danger' : pace > 5 ? 'warn' : 'done';
        const dlLabel = formatDateISO(new Date(themeDeadline + 'T00:00:00')).replace(/-/g, '/');
        headerHtml += `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">`;
        headerHtml += `<span class="deadline-badge ${calDays <= 7 ? (calDays <= 0 ? 'danger' : 'warn') : 'ok'}" style="font-size:0.7rem;">`;
        headerHtml += `${dlLabel}`;
        headerHtml += `</span>`;
        headerHtml += `<span style="font-size:0.72rem;font-weight:600;color:var(--color-${paceClass});">${pace}本/日</span>`;
        headerHtml += `</div>`;
      } else if (calDays !== null && calDays <= 0) {
        headerHtml += `<div style="margin-top:4px;"><span class="deadline-badge danger" style="font-size:0.7rem;">期限超過</span></div>`;
      }
    } else if (themeDeadline && remaining === 0 && total > 0) {
      headerHtml += `<div style="margin-top:4px;"><span class="deadline-badge ok" style="font-size:0.7rem;">完了</span></div>`;
    }

    // Leaf controls
    if (isLeaf && theme.total > 0) {
      headerHtml += `<div class="theme-controls">
        <button class="btn-counter" onclick="app.decrementTheme('${theme.id}')" aria-label="-1">−</button>
        <input type="range" class="theme-slider" id="slider-${theme.id}" min="0" max="${theme.total}" value="${theme.completed}"
          style="--p:${percent};--slider-fill:${color}"
          oninput="app.liveUpdate('${theme.id}',parseInt(this.value))"
          onchange="app.commitUpdate('${theme.id}',parseInt(this.value))" aria-label="進捗">
        <button class="btn-counter" onclick="app.incrementTheme('${theme.id}')" aria-label="+1">＋</button>
        <span class="theme-count-display" id="count-${theme.id}"><strong>${completed}</strong> / ${total}本</span>
      </div>`;
    } else if (hasChildren) {
      headerHtml += `<div id="parent-count-${theme.id}" style="font-size:0.75rem;color:var(--text-2);margin-top:2px;font-variant-numeric:tabular-nums;">
        ${completed} / ${total}本 完了</div>`;
    }

    card.innerHTML = headerHtml;

    // Children
    if (hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = `theme-children ${theme.expanded ? '' : 'collapsed'}`;

      theme.children.forEach((child, ci) => {
        renderThemeCard(childContainer, child, depth + 1, colorIdx * 10 + ci);
      });

      const subAddBtn = document.createElement('button');
      subAddBtn.className = 'sub-add-btn';
      subAddBtn.textContent = `＋ ${escapeHtml(theme.name)}にサブテーマ追加`;
      subAddBtn.addEventListener('click', () => openThemeModal(theme.id, null));
      childContainer.appendChild(subAddBtn);

      card.appendChild(childContainer);
    }

    container.appendChild(card);
  }

  // ===========================================================
  //  Actions
  // ===========================================================

  // -- Theme CRUD --
  function openThemeModal(parentId, editId) {
    const titleEl = document.getElementById('theme-modal-title');
    const nameInput = document.getElementById('theme-name-input');
    const totalInput = document.getElementById('theme-total-input');
    const deadlineInput = document.getElementById('theme-deadline-input');
    const saveBtn = document.getElementById('theme-save-btn');

    if (editId) {
      const project = getActiveProject();
      const theme = findThemeById(project.themes, editId);
      if (!theme) return;
      titleEl.textContent = 'テーマを編集';
      nameInput.value = theme.name;
      totalInput.value = theme.children.length > 0 ? '' : theme.total;
      totalInput.disabled = theme.children.length > 0;
      deadlineInput.value = theme.deadline || '';
      saveBtn.setAttribute('data-edit-id', editId);
      saveBtn.removeAttribute('data-parent-id');
    } else {
      const label = parentId ? 'サブテーマを追加' : 'テーマを追加';
      titleEl.textContent = label;
      nameInput.value = '';
      totalInput.value = '';
      totalInput.disabled = false;
      deadlineInput.value = '';
      saveBtn.removeAttribute('data-edit-id');
      if (parentId) {
        saveBtn.setAttribute('data-parent-id', parentId);
      } else {
        saveBtn.removeAttribute('data-parent-id');
      }
    }

    showModal('theme-modal');
    setTimeout(() => nameInput.focus(), 200);
  }

  function saveTheme() {
    const nameInput = document.getElementById('theme-name-input');
    const totalInput = document.getElementById('theme-total-input');
    const deadlineInput = document.getElementById('theme-deadline-input');
    const saveBtn = document.getElementById('theme-save-btn');
    const editId = saveBtn.getAttribute('data-edit-id');
    const parentId = saveBtn.getAttribute('data-parent-id');

    const name = nameInput.value.trim();
    const total = parseInt(totalInput.value, 10);
    const deadline = deadlineInput.value || '';

    if (!name) { nameInput.focus(); return; }
    if (!totalInput.disabled && (isNaN(total) || total < 1)) { totalInput.focus(); return; }

    const project = getActiveProject();

    if (editId) {
      const theme = findThemeById(project.themes, editId);
      if (theme) {
        theme.name = name;
        theme.deadline = deadline;
        if (theme.children.length === 0) {
          theme.total = total;
          if (theme.completed > total) theme.completed = total;
        }
        showToast(`「${name}」を更新しました`);
      }
    } else {
      const newTheme = {
        id: generateId(),
        name,
        total: total || 0,
        completed: 0,
        deadline,
        children: [],
        expanded: true,
      };

      if (parentId) {
        const parent = findThemeById(project.themes, parentId);
        if (parent) {
          if (parent.children.length === 0 && parent.total > 0) {
            parent.children.push({
              id: generateId(),
              name: parent.name,
              total: parent.total,
              completed: parent.completed,
              deadline: parent.deadline || '',
              children: [],
              expanded: true,
            });
            parent.total = 0;
            parent.completed = 0;
          }
          parent.children.push(newTheme);
          parent.expanded = true;
        }
      } else {
        project.themes.push(newTheme);
      }
      showToast(`「${name}」を追加しました`);
    }

    closeModal('theme-modal');
    render();
  }

  function deleteTheme(themeId) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme) return;
    if (!confirm(`「${theme.name}」を削除しますか？`)) return;
    removeThemeById(project.themes, themeId);
    render();
    showToast(`「${theme.name}」を削除しました`);
  }

  // ===========================================================
  //  Bulk Input
  // ===========================================================
  function collectAllThemes(themes, result, depth) {
    depth = depth || 0;
    for (const t of themes) {
      result.push({ id: t.id, name: t.name, depth });
      if (t.children.length > 0) {
        collectAllThemes(t.children, result, depth + 1);
      }
    }
    return result;
  }

  function openBulkAdd() {
    const project = getActiveProject();
    const select = document.getElementById('bulk-parent-select');
    select.innerHTML = '<option value="">プロジェクト直下（トップレベル）</option>';

    const allThemes = collectAllThemes(project.themes, []);
    allThemes.forEach(t => {
      const indent = '\u00A0\u00A0'.repeat(t.depth);
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = indent + t.name;
      select.appendChild(opt);
    });

    document.getElementById('bulk-textarea').value = '';
    showModal('bulk-modal');
    setTimeout(() => document.getElementById('bulk-textarea').focus(), 200);
  }

  function parseBulkText(text) {
    const lines = text.split('\n').filter(l => l.trim());
    const root = [];
    const stack = [{ children: root, indent: -1 }];

    for (const line of lines) {
      const stripped = line.replace(/\t/g, '  ');
      const indent = stripped.search(/\S/);
      const content = stripped.trim();
      if (!content) continue;

      // Parse "name number" or just "name"
      const match = content.match(/^(.+?)\s+(\d+)\s*$/);
      let name, total;
      if (match) {
        name = match[1].trim();
        total = parseInt(match[2], 10);
      } else {
        name = content;
        total = 0; // parent theme (group)
      }

      const node = {
        id: generateId(),
        name,
        total,
        completed: 0,
        deadline: '',
        children: [],
        expanded: true,
      };

      // Find the right parent based on indentation
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1];
      parent.children.push(node);
      stack.push({ children: node.children, indent });
    }

    return root;
  }

  function saveBulk() {
    const text = document.getElementById('bulk-textarea').value;
    const parentId = document.getElementById('bulk-parent-select').value;

    if (!text.trim()) {
      showToast('テーマを入力してください');
      return;
    }

    const parsed = parseBulkText(text);
    if (parsed.length === 0) {
      showToast('有効なテーマが見つかりません');
      return;
    }

    const project = getActiveProject();

    if (parentId) {
      const parent = findThemeById(project.themes, parentId);
      if (parent) {
        // Convert leaf to parent if needed
        if (parent.children.length === 0 && parent.total > 0) {
          parent.children.push({
            id: generateId(),
            name: parent.name,
            total: parent.total,
            completed: parent.completed,
            deadline: parent.deadline || '',
            children: [],
            expanded: true,
          });
          parent.total = 0;
          parent.completed = 0;
        }
        parent.children.push(...parsed);
        parent.expanded = true;
      }
    } else {
      project.themes.push(...parsed);
    }

    closeModal('bulk-modal');
    render();

    const count = countThemesRecursive(parsed);
    showToast(`${count}件のテーマを追加しました`);
  }

  function countThemesRecursive(themes) {
    let count = themes.length;
    for (const t of themes) {
      if (t.children.length > 0) count += countThemesRecursive(t.children);
    }
    return count;
  }

  function editTheme(themeId) {
    openThemeModal(null, themeId);
  }

  function toggleTheme(themeId) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme) return;
    theme.expanded = !theme.expanded;

    // Optimized: toggle without full re-render
    const btn = document.querySelector(`[onclick="app.toggleTheme('${themeId}')"]`);
    if (btn) {
      btn.classList.toggle('expanded', theme.expanded);
    }

    const card = btn ? btn.closest('.theme-card') : null;
    if (card) {
      const children = card.querySelector(':scope > .theme-children');
      if (children) {
        children.classList.toggle('collapsed', !theme.expanded);
      }
    }
    persist();
  }

  // Lightweight update: only update numbers & bars, NO DOM rebuild
  function liveUpdateProgress(themeId, value) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme) return;
    theme.completed = Math.max(0, Math.min(value, theme.total));

    // Update this theme's bar & count by ID
    const pct = theme.total > 0 ? (theme.completed / theme.total) * 100 : 0;
    // 葉テーマはスライダーの塗り(--p)が進捗線。親に昇格していた場合のfill-/pct-も念のため更新。
    const sliderEl = document.getElementById('slider-' + themeId);
    const fillEl = document.getElementById('fill-' + themeId);
    const pctEl = document.getElementById('pct-' + themeId);
    const countEl = document.getElementById('count-' + themeId);
    if (sliderEl) sliderEl.style.setProperty('--p', pct);
    if (fillEl) fillEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (countEl) countEl.innerHTML = '<strong>' + theme.completed + '</strong> / ' + theme.total + '本';

    // Update ancestor themes' bars & counts
    const ancestors = findThemeAncestors(project.themes, themeId) || [];
    for (const anc of ancestors) {
      const ap = calcThemeProgress(anc);
      const apct = ap.total > 0 ? (ap.completed / ap.total) * 100 : 0;
      const af = document.getElementById('fill-' + anc.id);
      const at = document.getElementById('pct-' + anc.id);
      const ac = document.getElementById('parent-count-' + anc.id);
      if (af) af.style.width = apct + '%';
      if (at) at.textContent = Math.round(apct) + '%';
      if (ac) ac.textContent = ap.completed + ' / ' + ap.total + '本 完了';
    }

    // Update overall stats (lightweight)
    updateStatsDOM(project);
    updateOverallProgressDOM(project);
    updateTodayDOM(project);

    // Update project tab progress
    updateActiveTabProgress(project);
  }

  // Update just the active tab's progress percentage
  function updateActiveTabProgress(project) {
    const { total, completed } = calcAllProgress(project.themes);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const tabs = document.querySelectorAll('.project-tab.active .project-tab-progress');
    tabs.forEach(t => { if (t.textContent !== pct + '%') t.textContent = pct + '%'; });
  }

  // Full update: rebuild DOM + persist (called on slider release & +/- buttons)
  function commitUpdate(themeId, value) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme) return;

    const oldTotal = calcAllProgress(project.themes);
    theme.completed = Math.max(0, Math.min(value, theme.total));
    const newTotal = calcAllProgress(project.themes);

    if (newTotal.completed === newTotal.total && newTotal.total > 0 && oldTotal.completed !== newTotal.completed) {
      celebrate();
    }

    // Instead of full render, do lightweight update + persist
    liveUpdateProgress(themeId, theme.completed);
    persistNow();
  }

  function incrementTheme(themeId) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme || theme.completed >= theme.total) return;

    theme.completed += 1;

    // Update slider value in DOM
    const slider = document.querySelector(`.theme-slider[oninput*="'${themeId}'"]`);
    if (slider) slider.value = theme.completed;

    commitUpdate(themeId, theme.completed);
  }

  function decrementTheme(themeId) {
    const project = getActiveProject();
    const theme = findThemeById(project.themes, themeId);
    if (!theme || theme.completed <= 0) return;

    theme.completed -= 1;

    // Update slider value in DOM
    const slider = document.querySelector(`.theme-slider[oninput*="'${themeId}'"]`);
    if (slider) slider.value = theme.completed;

    commitUpdate(themeId, theme.completed);
  }

  // -- Project CRUD --
  function deleteProject(projectId) {
    if (state.projects.length <= 1) return;
    const project = state.projects.find(p => p.id === projectId);
    if (!confirm(`プロジェクト「${project.name}」を削除しますか？`)) return;
    state.projects = state.projects.filter(p => p.id !== projectId);
    if (state.activeProjectId === projectId) {
      state.activeProjectId = state.projects[0].id;
    }
    render();
    showToast(`「${project.name}」を削除しました`);
  }

  // -- Settings --
  function openSettingsModal() {
    const project = getActiveProject();
    document.getElementById('settings-project-name').value = project.name;
    document.getElementById('settings-deadline').value = project.deadline || '';

    DAY_NAMES.forEach((_, i) => {
      const cb = document.getElementById(`rest-day-${i}`);
      if (cb) cb.checked = project.restDays.includes(i);
    });

    renderHolidayList(project);
    showModal('settings-modal');
  }

  function renderHolidayList(project) {
    const container = document.getElementById('holiday-list');
    container.innerHTML = '';
    const sorted = [...project.holidays].sort();
    sorted.forEach(date => {
      const tag = document.createElement('span');
      tag.className = 'holiday-tag';
      tag.innerHTML = `${date} <button class="holiday-tag-remove" onclick="app.removeHoliday('${date}')" aria-label="削除">✕</button>`;
      container.appendChild(tag);
    });
  }

  function addHoliday() {
    const input = document.getElementById('holiday-date-input');
    const date = input.value;
    if (!date) return;
    const project = getActiveProject();
    if (!project.holidays.includes(date)) {
      project.holidays.push(date);
      renderHolidayList(project);
    }
    input.value = '';
  }

  function removeHoliday(date) {
    const project = getActiveProject();
    project.holidays = project.holidays.filter(d => d !== date);
    renderHolidayList(project);
  }

  function saveSettings() {
    const project = getActiveProject();
    const name = document.getElementById('settings-project-name').value.trim();
    const deadline = document.getElementById('settings-deadline').value;

    if (name) project.name = name;
    project.deadline = deadline;

    project.restDays = [];
    DAY_NAMES.forEach((_, i) => {
      const cb = document.getElementById(`rest-day-${i}`);
      if (cb && cb.checked) project.restDays.push(i);
    });

    closeModal('settings-modal');
    render();
    showToast('設定を保存しました');
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
    const code = generateSyncCode();
    document.getElementById('sync-export-area').value = code;
    state.lastBackup = Date.now();
    persistNow();
    renderBackupReminder();
  }

  function copySyncCode() {
    const area = document.getElementById('sync-export-area');
    if (!area.value) { generateAndShowSyncCode(); }
    navigator.clipboard.writeText(area.value).then(() => {
      showToast('同期コードをコピーしました');
    }).catch(() => {
      area.select();
      document.execCommand('copy');
      showToast('同期コードをコピーしました');
    });
  }

  function loadSyncCode() {
    const code = document.getElementById('sync-import-area').value.trim();
    if (!code) { showToast('同期コードを貼り付けてください'); return; }
    try {
      const imported = importSyncCode(code);
      if (!imported.projects || !Array.isArray(imported.projects)) throw new Error('invalid');
      state = migrateData(imported);
      state.activeProjectId = state.projects[0]?.id || state.activeProjectId;
      closeModal('sync-modal');
      render();
      showToast('データを読み込みました');
    } catch (e) {
      showToast('無効な同期コードです');
    }
  }

  function exportAllJSON() {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `progress_tracker_backup_${formatDateISO(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    state.lastBackup = Date.now();
    persistNow();
    renderBackupReminder();
    showToast('バックアップファイルをダウンロードしました');
  }

  function importJSONFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!imported.projects || !Array.isArray(imported.projects)) throw new Error('invalid');
        state = migrateData(imported);
        state.activeProjectId = state.projects[0]?.id || state.activeProjectId;
        closeModal('sync-modal');
        render();
        showToast('バックアップから復元しました');
      } catch (err) {
        showToast('無効なバックアップファイルです');
      }
    };
    reader.readAsText(file);
  }

  function handleFileImport() {
    const input = document.getElementById('import-file-input');
    if (input.files.length > 0) {
      importJSONFile(input.files[0]);
    }
  }

  function dismissBackup() {
    state.lastBackup = Date.now();
    persistNow();
    renderBackupReminder();
  }

  // ===========================================================
  //  Modal helpers
  // ===========================================================
  function showModal(id) {
    const overlay = document.getElementById(id);
    overlay.classList.add('active');
    // Close on backdrop click
    overlay.onclick = (e) => {
      if (e.target === overlay) closeModal(id);
    };
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('active');
  }

  // ===========================================================
  //  Celebration (minimal, no confetti for clean feel)
  // ===========================================================
  function celebrate() {
    showToast('全て完了しました！おめでとうございます！');
  }

  // ===========================================================
  //  Keyboard
  // ===========================================================
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
    // Enter in modal inputs to submit
    if (e.key === 'Enter' && !e.shiftKey) {
      const activeModal = document.querySelector('.modal-overlay.active');
      if (activeModal) {
        const activeEl = document.activeElement;
        if (activeEl && activeEl.tagName === 'INPUT' && activeEl.type !== 'date') {
          e.preventDefault();
          const primaryBtn = activeModal.querySelector('.btn-primary');
          if (primaryBtn) primaryBtn.click();
        }
      }
    }
  });

  // ===========================================================
  //  Public API
  // ===========================================================
  window.app = {
    // Settings
    openSettings: openSettingsModal,
    saveSettings,
    addHoliday,
    removeHoliday,
    // Themes
    openAddTheme: (parentId) => openThemeModal(parentId || null, null),
    saveTheme,
    deleteTheme,
    editTheme,
    toggleTheme,
    liveUpdate: liveUpdateProgress,
    commitUpdate,
    incrementTheme,
    decrementTheme,
    // Bulk
    openBulkAdd,
    saveBulk,
    // Sync
    openSync: openSyncModal,
    generateSync: generateAndShowSyncCode,
    copySync: copySyncCode,
    loadSync: loadSyncCode,
    exportJSON: exportAllJSON,
    handleFileImport,
    // Backup
    dismissBackup,
    // Modal
    closeModal,
  };

  // ===========================================================
  //  Init
  // ===========================================================
  document.addEventListener('DOMContentLoaded', () => {
    render();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  });

})();
