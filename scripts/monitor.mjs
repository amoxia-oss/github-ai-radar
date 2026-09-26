import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'radar.config.json');
const dataPath = path.join(root, 'docs', 'data.json');
const DAY = 86_400_000;
const API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const demo = process.argv.includes('--demo');

const config = JSON.parse(await fs.readFile(configPath, 'utf8'));

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysAgo(iso) {
  if (!iso) return 99999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'github-ai-radar'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function gh(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`GitHub API ${response.status}: ${url}\n${body.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function isToolLike(repo, excludePatterns) {
  if (repo.archived || repo.fork) return false;
  if ((repo.stargazers_count || 0) < config.minStars) return false;
  if (daysAgo(repo.pushed_at) > config.maxInactiveDays) return false;
  const name = (repo.name || '').toLowerCase();
  if (excludePatterns.some((rx) => rx.test(name))) return false;

  const haystack = [repo.name, repo.description, ...(repo.topics || [])].filter(Boolean).join(' ').toLowerCase();
  const negative = ['dataset', 'paper list', 'reading list', 'learning resources', 'tutorial collection'];
  if (negative.some((word) => haystack.includes(word))) return false;
  return true;
}

function classify(repo) {
  const text = [repo.name, repo.description, ...(repo.topics || [])].filter(Boolean).join(' ').toLowerCase();
  const rules = [
    ['Coding', ['coding-agent', 'code agent', 'developer tool', 'code assistant', 'ide', 'copilot', 'coding']],
    ['MCP', ['model-context-protocol', 'model context protocol', 'mcp-server', 'mcp server', ' mcp ']],
    ['Agents', ['ai-agent', 'agentic', 'multi-agent', 'autonomous agent', 'agent framework', 'browser agent']],
    ['Video', ['text-to-video', 'video generation', 'video generator', 'video diffusion']],
    ['Image', ['text-to-image', 'image generation', 'image generator', 'stable diffusion', 'diffusion model']],
    ['Voice', ['speech-to-text', 'text-to-speech', 'voice ai', 'voice agent', 'speech recognition', 'tts', 'asr']],
    ['RAG', ['retrieval-augmented', 'retrieval augmented', 'vector database', 'vector-db', 'rag']],
    ['Local AI', ['local llm', 'local-ai', 'on-device', 'ollama', 'gguf', 'inference server']],
    ['Automation', ['workflow automation', 'automation', 'browser automation']],
    ['LLM', ['llm', 'large language model', 'transformer', 'language model']]
  ];
  for (const [category, keywords] of rules) {
    if (keywords.some((keyword) => text.includes(keyword))) return category;
  }
  return 'Other AI';
}

function preScore(repo) {
  const stars = Math.log10((repo.stargazers_count || 0) + 10) * 20;
  const recency = clamp(30 - daysAgo(repo.pushed_at) / 8, 0, 30);
  const ageDays = Math.max(1, daysAgo(repo.created_at));
  const youth = clamp(20 - ageDays / 5, 0, 20);
  return stars + recency + youth;
}

async function getStarHistory(repo) {
  const [owner, name] = repo.full_name.split('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stargazers/history?per_page=8`;
  try {
    const weeks = await gh(url);
    const daily = [];
    for (const week of weeks) {
      for (let i = 0; i < (week.days || []).length; i += 1) {
        daily.push({ ts: week.week * 1000 + i * DAY, stars: Number(week.days[i] || 0) });
      }
    }
    daily.sort((a, b) => a.ts - b.ts);
    const now = Date.now();
    const sum = (windowDays) => daily
      .filter((d) => d.ts >= now - windowDays * DAY && d.ts <= now + DAY)
      .reduce((acc, d) => acc + d.stars, 0);
    return {
      stars7d: sum(7),
      stars30d: sum(30),
      daily30d: daily.filter((d) => d.ts >= now - 30 * DAY).map((d) => d.stars).slice(-30)
    };
  } catch (error) {
    if ([403, 404, 422].includes(error.status)) return { stars7d: null, stars30d: null, daily30d: [] };
    throw error;
  }
}

function percentileMap(items, getter) {
  const values = items.map((item) => Number(getter(item) ?? 0)).sort((a, b) => a - b);
  return (value) => {
    if (!values.length) return 0;
    let idx = 0;
    while (idx < values.length && values[idx] <= Number(value ?? 0)) idx += 1;
    return (idx / values.length) * 100;
  };
}

function rankRepos(repos, previous) {
  const p7 = percentileMap(repos, (r) => r.stars7d);
  const p30 = percentileMap(repos, (r) => r.stars30d);
  const pGrowth = percentileMap(repos, (r) => r.growth7dPercent);
  const pTotal = percentileMap(repos, (r) => r.stars);
  const pFresh = percentileMap(repos, (r) => 1 / (1 + r.daysSincePush));

  const withScore = repos.map((repo) => {
    const score =
      p7(repo.stars7d) * 0.45 +
      pGrowth(repo.growth7dPercent) * 0.20 +
      p30(repo.stars30d) * 0.15 +
      pFresh(1 / (1 + repo.daysSincePush)) * 0.10 +
      pTotal(repo.stars) * 0.10;
    return { ...repo, trendScore: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.trendScore - a.trendScore || (b.stars7d || 0) - (a.stars7d || 0));

  const prevRank = new Map((previous?.repos || []).map((r) => [r.fullName, r.rank]));
  const prevByName = new Map((previous?.repos || []).map((r) => [r.fullName, r]));

  return withScore.map((repo, index) => {
    const rank = index + 1;
    const oldRank = prevRank.get(repo.fullName);
    const old = prevByName.get(repo.fullName);
    return {
      ...repo,
      rank,
      rankChange: oldRank ? oldRank - rank : null,
      newEntry: !oldRank,
      starsChangeSinceLastRun: old ? repo.stars - old.stars : null
    };
  });
}

async function loadPrevious() {
  try {
    return JSON.parse(await fs.readFile(dataPath, 'utf8'));
  } catch {
    return null;
  }
}

function makeAlerts(ranked, previous) {
  if (!previous?.repos?.length) return [];
  const a = config.alerts;
  return ranked.filter((repo) => repo.rank <= a.topN).flatMap((repo) => {
    const reasons = [];
    if (repo.newEntry) reasons.push('TOP20_NEW');
    if ((repo.rankChange || 0) >= a.rankJump) reasons.push(`RANK_UP_${repo.rankChange}`);
    if ((repo.stars7d || 0) >= a.minStars7d && (repo.growth7dPercent || 0) >= a.minGrowth7dPercent) reasons.push('STAR_SURGE');
    return reasons.length ? [{ fullName: repo.fullName, rank: repo.rank, reasons }] : [];
  });
}

async function notifyChatwork(ranked, alerts) {
  const cwToken = process.env.CHATWORK_API_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!cwToken || !roomId || !alerts.length) return;
  const alertNames = new Set(alerts.map((a) => a.fullName));
  const lines = ranked.filter((r) => alertNames.has(r.fullName)).slice(0, 8).map((r) => {
    const growth = r.stars7d == null ? '7d n/a' : `+${r.stars7d.toLocaleString()}★ / 7d`;
    const rankMove = r.rankChange == null ? 'NEW' : r.rankChange > 0 ? `↑${r.rankChange}` : '→';
    return `#${r.rank} ${rankMove} ${r.fullName} — ${growth} — score ${r.trendScore}`;
  });
  const dashboard = process.env.RADAR_URL ? `\n${process.env.RADAR_URL}` : '';
  const body = `[info][title]GitHub AI Radar: 急上昇を検知[/title]${lines.join('\n')}${dashboard}[/info]`;
  const response = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': cwToken, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body })
  });
  if (!response.ok) throw new Error(`Chatwork post failed: ${response.status}`);
}

function demoData() {
  const now = new Date().toISOString();
  const demoRepos = [
    ['sample/agent-studio', 'AIエージェントを組み立てて実行するワークフロー基盤', 'Agents', 38420, 2450, 7900, 'TypeScript'],
    ['sample/code-pilot', 'ローカルとクラウドで使える自律型コーディングエージェント', 'Coding', 22110, 1980, 6100, 'Python'],
    ['sample/mcp-hub', 'MCPサーバーを検索・接続・管理するハブ', 'MCP', 12880, 1610, 5200, 'TypeScript'],
    ['sample/video-lab', 'オープンソース動画生成・編集ツールキット', 'Video', 18340, 1280, 4400, 'Python'],
    ['sample/local-brain', 'ローカルLLMの実行とモデル管理を簡単にするランタイム', 'Local AI', 69010, 990, 3800, 'Go'],
    ['sample/rag-stack', 'RAGアプリの評価・検索・運用をまとめたスタック', 'RAG', 15420, 780, 2600, 'Python'],
    ['sample/voice-agent', 'リアルタイム音声エージェントのOSSフレームワーク', 'Voice', 11750, 690, 2300, 'Python'],
    ['sample/image-flow', '生成画像ワークフローをノードで構築するUI', 'Image', 50100, 610, 2100, 'Python']
  ].map((x, i) => ({
    fullName: x[0], name: x[0].split('/')[1], owner: x[0].split('/')[0], description: x[1], category: x[2],
    stars: x[3], stars7d: x[4], stars30d: x[5], growth7dPercent: Math.round((x[4] / Math.max(1, x[3] - x[4])) * 1000) / 10,
    forks: Math.floor(x[3] * 0.12), openIssues: Math.floor(x[3] * 0.01), language: x[6], license: 'MIT',
    createdAt: new Date(Date.now() - (90 + i * 70) * DAY).toISOString(), pushedAt: new Date(Date.now() - i * 5 * 3_600_000).toISOString(), daysSincePush: 0,
    url: `https://github.com/${x[0]}`, homepage: '', topics: ['ai', x[2].toLowerCase().replaceAll(' ', '-')],
    daily30d: Array.from({ length: 30 }, (_, d) => Math.max(0, Math.round((x[4] / 7) * (0.35 + ((d + i) % 7) / 8)))),
    trendScore: 95 - i * 5.3, rank: i + 1, rankChange: i === 1 ? 4 : i === 2 ? 8 : 0, newEntry: i === 0, starsChangeSinceLastRun: 120 + i * 10
  }));
  return {
    generatedAt: now,
    apiVersion: API_VERSION,
    mode: 'demo',
    stats: { monitored: demoRepos.length, alerts: 3, categories: [...new Set(demoRepos.map((r) => r.category))].length },
    alerts: [
      { fullName: demoRepos[0].fullName, rank: 1, reasons: ['TOP20_NEW', 'STAR_SURGE'] },
      { fullName: demoRepos[1].fullName, rank: 2, reasons: ['STAR_SURGE'] },
      { fullName: demoRepos[2].fullName, rank: 3, reasons: ['RANK_UP_8'] }
    ],
    repos: demoRepos
  };
}

async function main() {
  if (demo) {
    const payload = demoData();
    await fs.writeFile(dataPath, JSON.stringify(payload, null, 2) + '\n');
    console.log(`Wrote demo data to ${dataPath}`);
    return;
  }

  const previous = await loadPrevious();
  const recent90 = isoDate(Date.now() - 90 * DAY);
  const excludePatterns = config.excludeNamePatterns.map((pattern) => new RegExp(pattern, 'i'));
  const discovered = new Map();

  for (const search of config.queries) {
    const q = search.q.replaceAll('{RECENT_90}', recent90);
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', q);
    url.searchParams.set('sort', search.sort || 'stars');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('per_page', String(config.maxResultsPerQuery));
    const result = await gh(url.toString());
    for (const repo of result.items || []) {
      if (!discovered.has(repo.full_name)) discovered.set(repo.full_name, repo);
    }
  }

  const candidates = [...discovered.values()]
    .filter((repo) => isToolLike(repo, excludePatterns))
    .sort((a, b) => preScore(b) - preScore(a))
    .slice(0, config.maxCandidates);

  console.log(`Discovered ${discovered.size}; analyzing ${candidates.length} candidates`);

  const enriched = [];
  const concurrency = 8;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const rows = await Promise.all(batch.map(async (repo) => {
      const history = await getStarHistory(repo);
      const stars = repo.stargazers_count || 0;
      const stars7d = history.stars7d;
      const growth7dPercent = stars7d == null ? 0 : Math.round((stars7d / Math.max(1, stars - stars7d)) * 1000) / 10;
      return {
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner?.login || '',
        description: repo.description || '',
        category: classify(repo),
        stars,
        stars7d,
        stars30d: history.stars30d,
        growth7dPercent,
        forks: repo.forks_count || 0,
        openIssues: repo.open_issues_count || 0,
        language: repo.language || '—',
        license: repo.license?.spdx_id || '—',
        createdAt: repo.created_at,
        pushedAt: repo.pushed_at,
        daysSincePush: daysAgo(repo.pushed_at),
        url: repo.html_url,
        homepage: repo.homepage || '',
        topics: repo.topics || [],
        daily30d: history.daily30d
      };
    }));
    enriched.push(...rows);
  }

  const ranked = rankRepos(enriched, previous);
  const alerts = makeAlerts(ranked, previous);
  const payload = {
    generatedAt: new Date().toISOString(),
    apiVersion: API_VERSION,
    mode: 'live',
    stats: {
      monitored: ranked.length,
      alerts: alerts.length,
      categories: new Set(ranked.map((r) => r.category)).size,
      authenticated: Boolean(token)
    },
    alerts,
    repos: ranked
  };

  await fs.writeFile(dataPath, JSON.stringify(payload, null, 2) + '\n');
  await notifyChatwork(ranked, alerts);
  console.log(`Wrote ${ranked.length} repositories, ${alerts.length} alerts`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
