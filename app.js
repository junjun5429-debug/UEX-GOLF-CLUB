'use strict';

const STORAGE_KEY = 'uex-golf-club:v1';
const SUPABASE_URL = 'https://qqzrvdscnwdmpdrqdqtz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_KZgbYMI3wmd4KE2FVyW_Xg_TH04wI69';
const SHARED_ROW_ID = 'uex-golf-club-scorebook';
const COURSE_API = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? '/api/course-search'
  : `${SUPABASE_URL}/functions/v1/course-search`;
const COURSE_SOURCES = '登録履歴 / Wikipedia / © OpenStreetMap contributors';
const RAKUTEN_ATTRIBUTION = `<!-- Rakuten Web Services Attribution Snippet FROM HERE -->
<a href="https://developers.rakuten.com/" target="_blank">Supported by Rakuten Developers</a>
<!-- Rakuten Web Services Attribution Snippet TO HERE -->`;
const MEMBER_DISPLAY_ORDER = ['吉田', '浅野', '中島', '玉井', '亀井', '中森'];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);

let state = loadState();
let currentView = 'dashboard';
let statsRoundLimit = null;
let courseSearchTimer = null;
let courseSearchController = null;
let courseDirectoryPromise = null;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && Array.isArray(parsed.members) && Array.isArray(parsed.rounds)) return parsed;
  } catch (_) {
    // Invalid local data falls back to a clean score book.
  }
  return { version: 1, members: [], rounds: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function normalizeSharedData(value) {
  const data = value?.data || value;
  if (!data || !Array.isArray(data.members) || !Array.isArray(data.rounds)) return null;
  return { version: 1, members: data.members, rounds: data.rounds };
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function getSharedData() {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_scores?id=eq.${encodeURIComponent(SHARED_ROW_ID)}&select=data`,
      { headers: supabaseHeaders(), cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`read ${response.status}`);
    const rows = await response.json();
    return normalizeSharedData(rows[0]?.data);
  } catch (error) {
    console.error('共有データの取得に失敗しました', error);
    return null;
  }
}

async function pushSharedData() {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/shared_scores?on_conflict=id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: SHARED_ROW_ID, data: state, updated_at: new Date().toISOString() }),
    });
    if (!response.ok) throw new Error(`write ${response.status}`);
    return true;
  } catch (error) {
    console.error('共有データの更新に失敗しました', error);
    return false;
  }
}

function saveAndShare(successMessage) {
  saveState();
  showToast(`${successMessage}（共有を更新中…）`);
  pushSharedData().then((ok) => showToast(ok ? '共有データを更新しました' : '端末には保存しましたが、共有更新に失敗しました'));
}

function stateSignature(value) {
  return JSON.stringify({ members: value.members, rounds: value.rounds });
}

async function pullSharedData({ confirmOverwrite = true } = {}) {
  showToast('最新データを確認中…');
  const shared = await getSharedData();
  if (!shared) {
    showToast('共有データはまだありません');
    return false;
  }
  if (stateSignature(state) === stateSignature(shared)) {
    showToast(`すでに最新です（${shared.rounds.length}ラウンド）`);
    return true;
  }
  if (confirmOverwrite && !window.confirm(`最新の共有データ（${shared.rounds.length}ラウンド）を取得しますか？\nこの端末のデータは上書きされます。`)) return false;
  state = shared;
  saveState();
  setView('dashboard');
  showToast('最新データを取得しました');
  return true;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(`${value}T00:00:00`));
}

function memberById(id) {
  return state.members.find((member) => member.id === id);
}

function membersInDisplayOrder(members = state.members) {
  const priority = new Map(MEMBER_DISPLAY_ORDER.map((name, index) => [name, index]));
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => (priority.get(a.member.name) ?? MEMBER_DISPLAY_ORDER.length) - (priority.get(b.member.name) ?? MEMBER_DISPLAY_ORDER.length) || a.index - b.index)
    .map(({ member }) => member);
}

function sortedRounds() {
  return [...state.rounds].sort((a, b) => b.date.localeCompare(a.date));
}

function scoresForMember(memberId) {
  return state.rounds
    .map((round) => Number(round.scores[memberId]))
    .filter((score) => Number.isFinite(score) && score > 0);
}

function statsForMember(memberId, roundLimit = null) {
  const memberRounds = sortedRounds().filter((round) => Number(round.scores[memberId]) > 0);
  const rounds = roundLimit ? memberRounds.slice(0, roundLimit) : memberRounds;
  const scores = rounds.map((round) => Number(round.scores[memberId]));
  return {
    count: scores.length,
    best: scores.length ? Math.min(...scores) : null,
    average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    latestScore: rounds.length ? Number(rounds[0].scores[memberId]) : null,
    latestDate: rounds.length ? rounds[0].date : null,
  };
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 1800);
}

function setCourseSuggestions(names, searching = false) {
  const list = $('#course-suggestions');
  const input = $('#round-course');
  if (searching) {
    list.innerHTML = '<div class="course-searching">候補を検索中...</div>';
  } else {
    const options = names.map((name) => `<button type="button" class="course-suggestion" role="option" aria-selected="false">${escapeHtml(name)}</button>`).join('');
    list.innerHTML = names.length
      ? `<div class="course-option-list">${options}</div><div class="course-source"><span>${COURSE_SOURCES}</span>${RAKUTEN_ATTRIBUTION}</div>`
      : '';
  }
  const visible = searching || names.length > 0;
  list.classList.toggle('hidden', !visible);
  input.setAttribute('aria-expanded', String(visible));
  $$('.course-suggestion', list).forEach((button) => button.addEventListener('click', () => {
    input.value = button.textContent;
    setCourseSuggestions([]);
    input.focus();
  }));
}

function normalizeCourseName(value) {
  return String(value || '').normalize('NFKC').replace(/[\s　・･]/g, '').toLocaleLowerCase();
}

function matchesCourseQuery(name, query) {
  return normalizeCourseName(name).includes(normalizeCourseName(query));
}

function normalizeScoreInput(input) {
  input.value = input.value.normalize('NFKC').replace(/\D/g, '').slice(0, 3);
}

function loadCourseDirectory(signal) {
  if (!courseDirectoryPromise) {
    const params = new URLSearchParams({
      action: 'parse',
      page: '日本のゴルフ場一覧',
      prop: 'links',
      format: 'json',
      origin: '*',
    });
    courseDirectoryPromise = fetch(`https://ja.wikipedia.org/w/api.php?${params}`, { signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => (data?.parse?.links || []).map((link) => link['*']).filter(Boolean))
      .catch((error) => {
        courseDirectoryPromise = null;
        if (error.name === 'AbortError') return [];
        throw error;
      });
  }
  return courseDirectoryPromise;
}

async function searchCourseCandidates(query) {
  courseSearchController?.abort();
  courseSearchController = new AbortController();
  const signal = courseSearchController.signal;
  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(`${query} ゴルフ場`)}&limit=12`;
  const wikiParams = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `${query} ゴルフ場`,
    srlimit: '20',
    format: 'json',
    origin: '*',
  });
  const coursePattern = /(ゴルフ場|ゴルフクラブ|ゴルフ倶楽部|カントリークラブ|カントリー倶楽部|カンツリー倶楽部|golf|\bGC\b)/i;
  const candidates = new Set();
  const publish = (names) => {
    if (signal.aborted || $('#round-course').value.trim() !== query) return;
    names.filter(Boolean).forEach((name) => candidates.add(name));
    if (candidates.size) setCourseSuggestions([...candidates].slice(0, 10));
  };
  publish(sortedRounds().map((round) => round.course).filter((name) => matchesCourseQuery(name, query)));
  await Promise.allSettled([
    fetch(`${COURSE_API}?keyword=${encodeURIComponent(query)}`, { signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => publish((data?.courses || []).map((course) => course.name))),
    loadCourseDirectory(signal).then((names) => publish(names
      .filter((name) => matchesCourseQuery(name, query))
      .filter((name) => coursePattern.test(name) || !/(市|区|町|村|県|府|都|道|郡)$/.test(name))
      .slice(0, 10))),
    fetch(photonUrl, { signal })
      .then((response) => response.ok ? response.json() : null)
      .then((photon) => publish((photon?.features || [])
        .filter((feature) => feature.properties?.osm_value === 'golf_course' || coursePattern.test(feature.properties?.name || ''))
        .map((feature) => feature.properties.name)
        .filter((name) => matchesCourseQuery(name, query)))),
    fetch(`https://ja.wikipedia.org/w/api.php?${wikiParams}`, { signal })
      .then((response) => response.ok ? response.json() : null)
      .then((wiki) => publish((wiki?.query?.search || [])
        .map((result) => result.title)
        .filter((name) => matchesCourseQuery(name, query) && coursePattern.test(name) && !name.endsWith('一覧')))),
  ]);
  if (!signal.aborted && !candidates.size && $('#round-course').value.trim() === query) setCourseSuggestions([]);
}

function scheduleCourseSearch() {
  window.clearTimeout(courseSearchTimer);
  courseSearchController?.abort();
  const query = $('#round-course').value.trim();
  if (query.length < 2) {
    setCourseSuggestions([]);
    return;
  }
  setCourseSuggestions([], true);
  courseSearchTimer = window.setTimeout(() => searchCourseCandidates(query).catch((error) => {
    if (error.name !== 'AbortError') setCourseSuggestions([]);
  }), 450);
}

function setView(view) {
  currentView = view;
  $$('.view').forEach((element) => element.classList.toggle('hidden', element.id !== `${view}-view`));
  $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'rounds') renderRounds();
  if (currentView === 'members') renderMembers();
}

function renderDashboard() {
  const target = $('#dashboard-view');
  const activeMembers = membersInDisplayOrder().filter((member) => member.active !== false);
  const allResults = sortedRounds().flatMap((round) => Object.entries(round.scores).map(([memberId, score]) => ({ roundId: round.id, memberId, score: Number(score), date: round.date })));
  const allScores = allResults.map((result) => result.score).filter((score) => score > 0);
  const clubBest = allScores.length ? Math.min(...allScores) : null;
  const clubRecord = allResults.find((result) => result.score === clubBest);

  if (!state.members.length) {
    target.innerHTML = `
      <div class="page-head"><div><span class="eyebrow">CLUB SCORE BOOK</span><h1>ダッシュボード</h1></div></div>
      <div class="empty-state"><span class="empty-icon">⛳</span><h2>最初のメンバーを登録</h2><p>メンバー登録後、ラウンドを追加できます。</p><button class="primary" id="empty-add-member" type="button">＋ メンバーを追加</button></div>`;
    $('#empty-add-member').addEventListener('click', () => openMemberDialog());
    return;
  }

  const cards = activeMembers.map((member) => {
    const stats = statsForMember(member.id, statsRoundLimit);
    return `<button type="button" class="member-card" data-member-history="${member.id}" aria-label="${escapeHtml(member.name)}のラウンド履歴を表示">
      <span class="member-count">${stats.count} ROUNDS</span><div class="member-name">${escapeHtml(member.name)}</div>
      <div class="score-pair"><div><span>BEST</span><strong>${stats.best ?? '−'}</strong></div><div><span>AVERAGE</span><strong>${stats.average == null ? '−' : stats.average.toFixed(1)}</strong></div></div>
      <div class="latest-score"><span>LATEST</span><strong>${stats.latestScore ?? '−'}</strong><small>${stats.latestDate ? formatDate(stats.latestDate) : '記録なし'}</small></div>
    </button>`;
  }).join('');

  const recent = sortedRounds().slice(0, 5);
  const rangeOptions = [
    { value: 'all', label: '全成績' },
    { value: '20', label: '直近20' },
    { value: '10', label: '直近10' },
    { value: '5', label: '直近5' },
  ];
  target.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">CLUB SCORE BOOK</span><h1>ダッシュボード</h1></div><button class="primary" id="dashboard-add-round" type="button">＋ ラウンドを追加</button></div>
    <div class="summary-grid">
      <button class="summary-card" type="button" data-go="members" aria-label="メンバーを表示"><span>MEMBERS</span><strong>${activeMembers.length}</strong><small>登録メンバー</small></button>
      <button class="summary-card" type="button" data-go="rounds" aria-label="ラウンド履歴を表示"><span>ROUNDS</span><strong>${state.rounds.length}</strong><small>登録ラウンド</small></button>
      <button class="summary-card" type="button" ${clubRecord ? `data-round-id="${clubRecord.roundId}" aria-label="ベストスコアのラウンド詳細を表示"` : 'disabled'}><span>RECORD</span><strong>${clubBest ?? '−'}</strong><small>${clubRecord ? `${escapeHtml(memberById(clubRecord.memberId)?.name || '旧メンバー')} / ${formatDate(clubRecord.date)}` : '記録なし'}</small></button>
    </div>
    <div class="section-head member-stats-head"><h2>メンバー成績</h2><div class="section-tools"><div class="segmented-control" role="group" aria-label="成績の集計範囲">${rangeOptions.map((option) => `<button type="button" data-stats-range="${option.value}" class="${(statsRoundLimit ?? 'all').toString() === option.value ? 'active' : ''}">${option.label}</button>`).join('')}</div><button class="text-button" data-go="members" type="button">メンバー管理</button></div></div>
    <div class="member-grid">${cards || '<div class="empty-state"><p>アクティブなメンバーはいません。</p></div>'}</div>
    <div class="section-head"><h2>最近のラウンド</h2><button class="text-button" data-go="rounds" type="button">すべて表示</button></div>
    ${recent.length ? `<div class="round-list">${recent.map(roundRowHtml).join('')}</div>` : '<div class="empty-state"><h2>ラウンドはまだありません</h2><p>最初のスコアを登録しましょう。</p></div>'}`;
  $('#dashboard-add-round').addEventListener('click', () => openRoundDialog());
  $$('[data-stats-range]', target).forEach((button) => button.addEventListener('click', () => {
    statsRoundLimit = button.dataset.statsRange === 'all' ? null : Number(button.dataset.statsRange);
    renderDashboard();
  }));
  $$('[data-member-history]', target).forEach((button) => button.addEventListener('click', () => openMemberHistory(button.dataset.memberHistory)));
  bindRoundRows(target);
  $$('[data-go]', target).forEach((button) => button.addEventListener('click', () => setView(button.dataset.go)));
}

function roundRowHtml(round) {
  const scores = Object.entries(round.scores)
    .filter(([, score]) => Number(score) > 0)
    .sort(([, a], [, b]) => Number(a) - Number(b))
    .map(([memberId, score]) => `<span class="score-chip">${escapeHtml(memberById(memberId)?.name || '旧メンバー')} ${Number(score)}</span>`)
    .join('');
  return `<button class="round-row" type="button" data-round-id="${round.id}">
    <span class="round-date">${formatDate(round.date)}</span>
    <span class="round-course">${escapeHtml(round.course)}<small>${Object.keys(round.scores).length}名参加</small></span>
    <span class="round-scores">${scores}</span><span class="chevron">›</span>
  </button>`;
}

function renderRounds() {
  const rounds = sortedRounds();
  const target = $('#rounds-view');
  target.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">HISTORY</span><h1>ラウンド履歴</h1></div><button class="primary" id="history-add-round" type="button">＋ ラウンドを追加</button></div>
    ${rounds.length ? `<div class="round-list">${rounds.map(roundRowHtml).join('')}</div>` : '<div class="empty-state"><span class="empty-icon">▤</span><h2>ラウンドはまだありません</h2><p>プレー日と参加メンバーのスコアを登録できます。</p></div>'}`;
  $('#history-add-round').addEventListener('click', () => openRoundDialog());
  bindRoundRows(target);
}

function bindRoundRows(root) {
  $$('[data-round-id]', root).forEach((button) => button.addEventListener('click', () => openRoundDetail(button.dataset.roundId)));
}

function memberScoreChartHtml(rounds, memberId, memberName) {
  if (!rounds.length) return '';
  const chronological = [...rounds].reverse();
  const scores = chronological.map((round) => Number(round.scores[memberId]));
  const width = 600;
  const height = 220;
  const padding = { top: 20, right: 18, bottom: 38, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const rawMin = Math.min(...scores);
  const rawMax = Math.max(...scores);
  const scorePadding = Math.max(3, Math.ceil((rawMax - rawMin) * 0.12));
  const minScore = Math.floor((rawMin - scorePadding) / 5) * 5;
  const maxScore = Math.ceil((rawMax + scorePadding) / 5) * 5;
  const scoreRange = Math.max(1, maxScore - minScore);
  const xFor = (index) => padding.left + (chronological.length === 1 ? plotWidth / 2 : (index / (chronological.length - 1)) * plotWidth);
  const yFor = (score) => padding.top + ((maxScore - score) / scoreRange) * plotHeight;
  const points = scores.map((score, index) => `${xFor(index).toFixed(1)},${yFor(score).toFixed(1)}`).join(' ');
  const guideValues = Array.from({ length: 5 }, (_, index) => Math.round(minScore + (scoreRange * index) / 4));
  const labelIndexes = [...new Set([0, Math.floor((chronological.length - 1) / 2), chronological.length - 1])];

  return `<div class="score-chart" role="img" aria-label="${escapeHtml(memberName)}のスコア推移">
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      ${guideValues.map((score) => `<g class="chart-guide"><line x1="${padding.left}" y1="${yFor(score).toFixed(1)}" x2="${width - padding.right}" y2="${yFor(score).toFixed(1)}"></line><text x="${padding.left - 8}" y="${(yFor(score) + 4).toFixed(1)}">${score}</text></g>`).join('')}
      <polyline class="chart-line" points="${points}"></polyline>
      ${scores.map((score, index) => `<g class="chart-point"><circle cx="${xFor(index).toFixed(1)}" cy="${yFor(score).toFixed(1)}" r="4"></circle><title>${formatDate(chronological[index].date)} ${score}</title></g>`).join('')}
      ${labelIndexes.map((index) => `<text class="chart-date" x="${xFor(index).toFixed(1)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === chronological.length - 1 ? 'end' : 'middle'}">${escapeHtml(chronological[index].date.replaceAll('-', '/'))}</text>`).join('')}
    </svg>
  </div>`;
}

function openMemberHistory(memberId) {
  const member = memberById(memberId);
  if (!member) return;
  const allRounds = sortedRounds().filter((round) => Number(round.scores[memberId]) > 0);
  const detail = $('#round-detail');

  function renderHistory(roundLimit = null) {
    const rounds = roundLimit ? allRounds.slice(0, roundLimit) : allRounds;
    const scores = rounds.map((round) => Number(round.scores[memberId]));
    const stats = {
      count: scores.length,
      best: scores.length ? Math.min(...scores) : null,
      average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    };
    const ranges = [{ value: 'all', label: '全成績' }, { value: '10', label: '直近10' }, { value: '5', label: '直近5' }];
    detail.innerHTML = `
      <div class="dialog-head"><div><span class="eyebrow">MEMBER HISTORY</span><h2>${escapeHtml(member.name)}</h2></div><button class="icon-button subtle" type="button" data-detail-close aria-label="閉じる">×</button></div>
      <div class="history-range"><h3>スコア推移</h3><div class="segmented-control" role="group" aria-label="表示する成績の範囲">${ranges.map((range) => `<button type="button" data-history-range="${range.value}" class="${(roundLimit ?? 'all').toString() === range.value ? 'active' : ''}">${range.label}</button>`).join('')}</div></div>
      ${memberScoreChartHtml(rounds, memberId, member.name)}
      <div class="history-summary"><div><span>BEST</span><strong>${stats.best ?? '−'}</strong></div><div><span>AVERAGE</span><strong>${stats.average == null ? '−' : stats.average.toFixed(1)}</strong></div><div><span>ROUNDS</span><strong>${stats.count}</strong></div></div>
      ${rounds.length ? `<div class="member-history-list">${rounds.map((round) => `<button type="button" class="member-history-row" data-history-round="${round.id}"><span><strong>${formatDate(round.date)}</strong><small>${escapeHtml(round.course)}</small></span><b>${Number(round.scores[memberId])}</b><i>›</i></button>`).join('')}</div>` : '<div class="empty-state"><p>ラウンド履歴はありません。</p></div>'}
      <div class="dialog-actions"><button class="secondary" type="button" data-detail-close>閉じる</button></div>`;
    $$('[data-detail-close]', detail).forEach((button) => button.addEventListener('click', () => $('#detail-dialog').close()));
    $$('[data-history-range]', detail).forEach((button) => button.addEventListener('click', () => renderHistory(button.dataset.historyRange === 'all' ? null : Number(button.dataset.historyRange))));
    $$('[data-history-round]', detail).forEach((button) => button.addEventListener('click', () => {
      $('#detail-dialog').close();
      openRoundDetail(button.dataset.historyRound);
    }));
  }

  renderHistory();
  $('#detail-dialog').showModal();
}

function renderMembers() {
  const target = $('#members-view');
  const rows = membersInDisplayOrder().map((member) => {
    const stats = statsForMember(member.id);
    const status = member.active === false ? '休止中' : `${stats.count}ラウンド / BEST ${stats.best ?? '−'}`;
    return `<div class="member-manage-row ${member.active === false ? 'inactive' : ''}">
      <div><strong>${escapeHtml(member.name)}</strong><small>${status}</small></div>
      <button class="secondary" type="button" data-edit-member="${member.id}">編集</button>
      <button class="danger" type="button" data-toggle-member="${member.id}">${member.active === false ? '再開' : '休止'}</button>
    </div>`;
  }).join('');
  target.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">MEMBERS</span><h1>メンバー</h1></div><button class="primary" id="add-member" type="button">＋ メンバーを追加</button></div>
    <div class="panel">${rows || '<div class="empty-state"><h2>メンバーはいません</h2></div>'}</div>`;
  $('#add-member').addEventListener('click', () => openMemberDialog());
  $$('[data-edit-member]', target).forEach((button) => button.addEventListener('click', () => openMemberDialog(button.dataset.editMember)));
  $$('[data-toggle-member]', target).forEach((button) => button.addEventListener('click', () => toggleMember(button.dataset.toggleMember)));
}

function openMemberDialog(memberId = '') {
  const member = memberId ? memberById(memberId) : null;
  $('#member-dialog-title').textContent = member ? 'メンバーを編集' : 'メンバーを追加';
  $('#member-id').value = member?.id || '';
  $('#member-name').value = member?.name || '';
  $('#member-error').textContent = '';
  $('#member-dialog').showModal();
  $('#member-name').focus();
}

function saveMember(event) {
  event.preventDefault();
  const id = $('#member-id').value;
  const name = $('#member-name').value.trim();
  if (!name) return;
  if (state.members.some((member) => member.name.toLocaleLowerCase() === name.toLocaleLowerCase() && member.id !== id)) {
    $('#member-error').textContent = '同じ名前のメンバーが登録されています。';
    return;
  }
  if (id) {
    memberById(id).name = name;
  } else {
    state.members.push({ id: uid(), name, active: true, createdAt: new Date().toISOString() });
  }
  saveAndShare(id ? 'メンバー情報を更新しました' : 'メンバーを追加しました');
  $('#member-dialog').close();
  render();
}

function toggleMember(memberId) {
  const member = memberById(memberId);
  if (!member) return;
  member.active = member.active === false;
  saveAndShare(member.active ? 'メンバーを再開しました' : 'メンバーを休止しました');
  render();
}

function openRoundDialog(roundId = '') {
  const orderedMembers = membersInDisplayOrder();
  const activeMembers = orderedMembers.filter((member) => member.active !== false);
  const round = roundId ? state.rounds.find((item) => item.id === roundId) : null;
  const availableMembers = round
    ? orderedMembers.filter((member) => member.active !== false || round.scores[member.id] != null)
    : activeMembers;
  if (!availableMembers.length) {
    setView('members');
    openMemberDialog();
    showToast('先にメンバーを追加してください');
    return;
  }
  $('#round-dialog-title').textContent = round ? 'ラウンドを編集' : 'ラウンドを登録';
  $('#round-id').value = round?.id || '';
  $('#round-date').value = round?.date || today();
  $('#round-course').value = round?.course || '';
  setCourseSuggestions([]);
  $('#round-notes').value = round?.notes || '';
  $('#round-error').textContent = '';
  $('#score-entry').innerHTML = availableMembers.map((member) => {
    const existingScore = round?.scores[member.id];
    const checked = round ? existingScore != null : false;
    return `<label class="score-entry-row ${checked ? '' : 'disabled'}" data-score-row>
      <input type="checkbox" data-member-check="${member.id}" ${checked ? 'checked' : ''} />
      <span>${escapeHtml(member.name)}</span>
      <input type="text" data-member-score="${member.id}" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" enterkeyhint="next" placeholder="Score" value="${existingScore ?? ''}" ${checked ? '' : 'disabled'} />
    </label>`;
  }).join('');
  $$('[data-member-score]', $('#score-entry')).forEach((input) => input.addEventListener('input', () => normalizeScoreInput(input)));
  $$('[data-member-check]', $('#score-entry')).forEach((checkbox) => checkbox.addEventListener('change', () => {
    const scoreInput = $(`[data-member-score="${checkbox.dataset.memberCheck}"]`, $('#score-entry'));
    scoreInput.disabled = !checkbox.checked;
    checkbox.closest('[data-score-row]').classList.toggle('disabled', !checkbox.checked);
    if (checkbox.checked) scoreInput.focus();
  }));
  $('#round-dialog').showModal();
}

function saveRound(event) {
  event.preventDefault();
  const scores = {};
  let invalid = false;
  $$('[data-member-check]:checked', $('#score-entry')).forEach((checkbox) => {
    const score = Number($(`[data-member-score="${checkbox.dataset.memberCheck}"]`, $('#score-entry')).value);
    if (!Number.isInteger(score) || score < 40 || score > 250) invalid = true;
    else scores[checkbox.dataset.memberCheck] = score;
  });
  if (!Object.keys(scores).length || invalid) {
    $('#round-error').textContent = '参加メンバーを1名以上選び、40〜250のスコアを入力してください。';
    return;
  }
  const id = $('#round-id').value;
  const round = {
    id: id || uid(),
    date: $('#round-date').value,
    course: $('#round-course').value.trim(),
    notes: $('#round-notes').value.trim(),
    scores,
    updatedAt: new Date().toISOString(),
  };
  if (id) state.rounds[state.rounds.findIndex((item) => item.id === id)] = round;
  else state.rounds.push(round);
  saveAndShare(id ? 'ラウンドを更新しました' : 'ラウンドを登録しました');
  $('#round-dialog').close();
  render();
}

function openRoundDetail(roundId) {
  const round = state.rounds.find((item) => item.id === roundId);
  if (!round) return;
  const scores = Object.entries(round.scores)
    .sort(([, a], [, b]) => Number(a) - Number(b))
    .map(([memberId, score]) => `<div class="detail-score"><span>${escapeHtml(memberById(memberId)?.name || '旧メンバー')}</span><strong>${Number(score)}</strong></div>`)
    .join('');
  $('#round-detail').innerHTML = `
    <div class="dialog-head"><div><span class="eyebrow">${formatDate(round.date)}</span><h2>${escapeHtml(round.course)}</h2></div><button class="icon-button subtle" type="button" data-detail-close aria-label="閉じる">×</button></div>
    <div class="detail-score-list">${scores}</div>
    ${round.notes ? `<div class="detail-notes">${escapeHtml(round.notes)}</div>` : ''}
    <div class="detail-actions"><button class="danger" type="button" data-delete-round="${round.id}">削除</button><div><button class="secondary" type="button" data-detail-close>閉じる</button><button class="primary" type="button" data-edit-round="${round.id}">編集</button></div></div>`;
  $$('[data-detail-close]', $('#round-detail')).forEach((button) => button.addEventListener('click', () => $('#detail-dialog').close()));
  $('[data-edit-round]', $('#round-detail')).addEventListener('click', () => {
    $('#detail-dialog').close();
    openRoundDialog(round.id);
  });
  $('[data-delete-round]', $('#round-detail')).addEventListener('click', () => deleteRound(round.id));
  $('#detail-dialog').showModal();
}

function deleteRound(roundId) {
  if (!window.confirm('このラウンドを削除しますか？')) return;
  state.rounds = state.rounds.filter((round) => round.id !== roundId);
  saveAndShare('ラウンドを削除しました');
  $('#detail-dialog').close();
  render();
}

function exportBackup() {
  const payload = JSON.stringify({ app: 'UEX-GOLF-CLUB', exportedAt: new Date().toISOString(), data: state }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `uex-golf-club-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const data = payload.data || payload;
    if (!Array.isArray(data.members) || !Array.isArray(data.rounds)) throw new Error('invalid');
    state = data;
    saveAndShare('バックアップを復元しました');
    render();
  } catch (_) {
    showToast('バックアップを読み込めませんでした');
  } finally {
    $('#import-file').value = '';
  }
}

$$('.tabs button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#home-button').addEventListener('click', () => setView('dashboard'));
$('#fab').addEventListener('click', () => openRoundDialog());
$('#export-button').addEventListener('click', () => pullSharedData());
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$('#settings-export').addEventListener('click', () => {
  $('#settings-dialog').close();
  exportBackup();
});
$('#settings-import').addEventListener('click', () => {
  $('#settings-dialog').close();
  $('#import-file').click();
});
$('#round-form').addEventListener('submit', saveRound);
$('#member-form').addEventListener('submit', saveMember);
$('#round-course').addEventListener('input', scheduleCourseSearch);
$('#round-course').addEventListener('keydown', (event) => {
  const options = $$('.course-suggestion');
  if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    options[0].focus();
  } else if (event.key === 'Escape') {
    setCourseSuggestions([]);
  }
});
$('#course-suggestions').addEventListener('keydown', (event) => {
  const options = $$('.course-suggestion', event.currentTarget);
  const index = options.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' && index < options.length - 1) {
    event.preventDefault();
    options[index + 1].focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (index > 0) options[index - 1].focus();
    else $('#round-course').focus();
  } else if (event.key === 'Escape') {
    setCourseSuggestions([]);
    $('#round-course').focus();
  }
});
$('#select-all-members').addEventListener('click', () => {
  $$('[data-member-check]', $('#score-entry')).forEach((checkbox) => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
  });
});
$$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#import-file').addEventListener('change', (event) => importBackup(event.target.files[0]));

async function init() {
  const hadLocalData = localStorage.getItem(STORAGE_KEY) !== null;
  if (!hadLocalData) {
    const shared = await getSharedData();
    if (shared) {
      state = shared;
      saveState();
    }
  }
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();