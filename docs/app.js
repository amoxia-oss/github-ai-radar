const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
let data = null;

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function relativeDate(iso) {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
  return days === 0 ? 'today' : `${days}d ago`;
}

function sparkline(values = []) {
  if (!values.length) return '<div class="spark"></div>';
  const max = Math.max(...values, 1);
  return `<div class="spark" title="直近30日のStar獲得推移">${values.map((v) => `<i style="height:${Math.max(4, Math.round((v / max) * 100))}%"></i>`).join('')}</div>`;
}

function rankMove(repo) {
  if (repo.newEntry) return '<small class="up">NEW</small>';
  if (repo.rankChange > 0) return `<small class="up">↑ ${repo.rankChange}</small>`;
  if (repo.rankChange < 0) return `<small class="down">↓ ${Math.abs(repo.rankChange)}</small>`;
  return '<small>—</small>';
}

function isHot(repo) {
  return data.alerts?.some((a) => a.fullName === repo.fullName);
}

function renderMetrics(repos) {
  const top = repos[0];
  const seven = repos.reduce((sum, r) => sum + (r.stars7d || 0), 0);
  const metrics = [
    ['監視中', `${repos.length} repos`],
    ['7日Star獲得', `+${nf.format(seven)}`],
    ['急上昇1位', top ? top.name : '—'],
    ['アラート', `${data.alerts?.length || 0}件`]
  ];
  $('metrics').innerHTML = metrics.map(([label, value]) => `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join('');
}

function getFiltered() {
  const q = $('search').value.trim().toLowerCase();
  const category = $('category').value;
  const alertsOnly = $('alertsOnly').checked;
  const alertSet = new Set((data.alerts || []).map((a) => a.fullName));
  let repos = data.repos.filter((repo) => {
    const haystack = [repo.fullName, repo.description, ...(repo.topics || [])].join(' ').toLowerCase();
    return (!q || haystack.includes(q)) && (category === 'all' || repo.category === category) && (!alertsOnly || alertSet.has(repo.fullName));
  });
  const sort = $('sort').value;
  const key = {
    trend: (r) => r.trendScore,
    stars7d: (r) => r.stars7d || 0,
    growth: (r) => r.growth7dPercent || 0,
    stars: (r) => r.stars,
    new: (r) => new Date(r.createdAt).getTime()
  }[sort];
  repos = [...repos].sort((a, b) => key(b) - key(a));
  return repos;
}

function render() {
  const repos = getFiltered();
  renderMetrics(repos);
  if (!repos.length) {
    $('cards').innerHTML = '<div class="empty">条件に一致するリポジトリがありません。</div>';
    return;
  }
  $('cards').innerHTML = repos.map((repo) => {
    const hot = isHot(repo);
    const badges = [
      `<span class="badge">${esc(repo.category)}</span>`,
      hot ? '<span class="badge hot">SURGE</span>' : '',
      repo.newEntry ? '<span class="badge new">NEW</span>' : ''
    ].join('');
    const star7 = repo.stars7d == null ? '—' : `+${nf.format(repo.stars7d)}`;
    const growth = repo.stars7d == null ? 'history unavailable' : `+${repo.growth7dPercent}% / 7d`;
    return `<article class="card">
      <div class="rank">#${repo.rank}${rankMove(repo)}</div>
      <div>
        <div class="repo-title"><a href="${esc(repo.url)}" target="_blank" rel="noreferrer">${esc(repo.fullName)}</a>${badges}</div>
        <p class="desc">${esc(repo.description || 'No description')}</p>
        <div class="meta"><span>${esc(repo.language || '—')}</span><span>★ ${nf.format(repo.stars)}</span><span>Fork ${nf.format(repo.forks)}</span><span>Push ${relativeDate(repo.pushedAt)}</span><span>${esc(repo.license || '—')}</span></div>
      </div>
      <div class="stat"><div class="label">STARS / 7 DAYS</div><div class="big">${star7}</div><div class="sub">${growth}</div></div>
      <div class="stat"><div class="label">STARS / 30 DAYS</div><div class="big">${repo.stars30d == null ? '—' : `+${nf.format(repo.stars30d)}`}</div>${sparkline(repo.daily30d)}</div>
      <div class="score"><div class="score-ring" style="--score:${Math.min(100, repo.trendScore)}"><b>${repo.trendScore}</b></div><div><div class="label">TREND SCORE</div><div class="meta">GitHub AI Radar</div></div></div>
    </article>`;
  }).join('');
}

async function init() {
  const response = await fetch(`./data.json?t=${Date.now()}`);
  data = await response.json();
  const date = new Date(data.generatedAt);
  $('status').textContent = `${data.mode === 'demo' ? 'DEMO · ' : ''}${date.toLocaleString('ja-JP')} 更新`;
  const categories = [...new Set(data.repos.map((r) => r.category))].sort();
  $('category').insertAdjacentHTML('beforeend', categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''));
  ['search', 'category', 'sort', 'alertsOnly'].forEach((id) => $(id).addEventListener('input', render));
  render();
}

init().catch((error) => {
  console.error(error);
  $('status').textContent = 'Data load failed';
  $('cards').innerHTML = '<div class="empty">data.json を読み込めませんでした。GitHub Actionsを実行してください。</div>';
});
