'use strict';

/* =========================================================
   Grok Football Match Predictor
   ---------------------------------------------------------
   NOTE: this key ships to every visitor's browser. Fine for a
   personal tool; for anything public, move calls behind a
   small server/proxy and rotate the key.
   ========================================================= */
const CONFIG = {
  API_KEY: 'fcfaa164b2acf8fc0446a6d01aa71815',
  BASE: 'https://v3.football.api-sports.io',
  MAX_PER_MINUTE: 10,         // free plan limit
  DISPLAY_TZ: 'Africa/Nairobi', // East Africa Time (EAT, UTC+3)
  FORM_WINDOW: 6,
  H2H_WINDOW: 10,
  // Modelling choices (NOT data). Disclosed in the app and tunable via the prediction log.
  HALF_LIFE_DAYS: 45,       // recency weighting of form
  SHRINK_K: 4,              // pseudo-games of league-average evidence mixed into every team rate
  SEASON_WEIGHT: 0.65,      // season-venue rates vs opponent-adjusted form
  MIN_LEAGUE_MATCHES: 20,   // below this a league baseline is not trusted
  MIN_OPP_GAMES: 3,         // opponents with fewer games are excluded from adjusted form
  DRAW_CAL_MIN: 0.85, DRAW_CAL_MAX: 1.30,
  LOG_KEY: 'gfmp.log.v1',
};

/* ---------- tiny helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f1 = (n) => (n == null ? 'n/a' : n.toFixed(2));
const pct = (n) => `${Math.round(n * 100)}%`;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ---------- rate-limited API client (free plan) ---------- */
class ApiError extends Error {
  constructor(msg, opts = {}) { super(msg); this.plan = !!opts.plan; }
}
const stamps = [];
let chain = Promise.resolve();
const stats = { requests: 0, log: [] };

function setStatus(msg, busy = true) {
  const el = $('#status');
  if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div>${esc(msg)}</div>${busy ? '<div class="bar"><i></i></div>' : ''}`;
}

function acquire() {
  const p = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= 60000) stamps.shift();
      if (stamps.length < CONFIG.MAX_PER_MINUTE) { stamps.push(now); return; }
      const wait = 60000 - (now - stamps[0]) + 250;
      setStatus(`Pausing ${Math.ceil(wait / 1000)}s to respect the free plan's 10 requests per minute...`);
      await sleep(Math.min(wait, 1000));
    }
  });
  chain = p.catch(() => {});
  return p;
}

async function api(path, params = {}, retry = true) {
  await acquire();
  const url = new URL(CONFIG.BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  let res;
  try {
    res = await fetch(url, { headers: { 'x-apisports-key': CONFIG.API_KEY } });
  } catch {
    throw new ApiError('Could not reach API-Football. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError(`API-Football returned HTTP ${res.status}.`);
  const json = await res.json();
  const errs = json.errors;
  const list = Array.isArray(errs) ? errs.map(String) : Object.entries(errs || {}).map(([k, v]) => `${k}: ${v}`);
  if (list.length) {
    const text = list.join('; ');
    if (/rateLimit|too many requests/i.test(text) && retry) {
      setStatus('Rate limit hit. Waiting 61 seconds, then retrying...');
      await sleep(61000);
      return api(path, params, false);
    }
    throw new ApiError(text, { plan: /plan/i.test(text) });
  }
  stats.requests += 1;
  return json.response || [];
}

/* ---------- domain helpers ---------- */

// API-Football seasons are named for the year they start (Aug 2026 - May 2027 = 2026).
function deriveSeason(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
function parsePlanSeason(msg) {
  const years = [...String(msg).matchAll(/\b(20\d{2})\b/g)].map((m) => +m[1]);
  return years.length ? Math.max(...years) : null;
}

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const isFinished = (f) => FINISHED.has(f.fixture.status.short) && f.goals.home != null && f.goals.away != null;
const NON_LEAGUE = /cup|copa|coppa|pokal|coupe|taça|taca|beker|trophy|shield|friendl|play-?off|qualif/i;

function perspective(f, teamId) {
  const home = f.teams.home.id === teamId;
  const gf = home ? f.goals.home : f.goals.away;
  const ga = home ? f.goals.away : f.goals.home;
  return {
    res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', gf, ga, home,
    opp: home ? f.teams.away.name : f.teams.home.name,
    comp: f.league.name, leagueId: f.league.id, ts: f.fixture.timestamp,
  };
}

function domesticLeague(fixtures) {
  const counts = new Map();
  fixtures.forEach((f) => {
    const l = f.league;
    if (l.country === 'World' || NON_LEAGUE.test(l.name)) return;
    const e = counts.get(l.id) || { id: l.id, name: l.name, country: l.country, n: 0 };
    e.n += 1; counts.set(l.id, e);
  });
  return [...counts.values()].sort((a, b) => b.n - a.n)[0] || null;
}
function competitionsOf(fixtures, kind) {
  const m = new Map();
  fixtures.forEach((f) => {
    const l = f.league;
    const continental = l.country === 'World' && !/friendl/i.test(l.name);
    const cup = l.country !== 'World' && NON_LEAGUE.test(l.name) && !/friendl|qualif/i.test(l.name);
    if ((kind === 'continental' && continental) || (kind === 'cup' && cup)) m.set(l.id, l.name);
  });
  return m;
}

/* ---------- Poisson model ---------- */
function poissonP(l, k) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}
function poissonDrawProb(lh, la) {
  let d = 0;
  for (let k = 0; k <= 10; k++) d += poissonP(lh, k) * poissonP(la, k);
  return d;
}
// c = draw-calibration multiplier applied to level scorelines (derived from the league's real draw rate)
function scoreGrid(lh, la, c = 1) {
  const M = 8, cells = [];
  let total = 0;
  for (let h = 0; h <= M; h++) {
    for (let a = 0; a <= M; a++) {
      const p = poissonP(lh, h) * poissonP(la, a) * (h === a ? c : 1);
      cells.push({ h, a, p }); total += p;
    }
  }
  let pH = 0, pD = 0, pA = 0, over25 = 0, btts = 0;
  const bestBy = { home: { p: -1, h: 1, a: 0 }, draw: { p: -1, h: 1, a: 1 }, away: { p: -1, h: 0, a: 1 } };
  cells.forEach((x) => {
    const p = x.p / total;
    const k = x.h > x.a ? 'home' : x.h === x.a ? 'draw' : 'away';
    if (k === 'home') pH += p; else if (k === 'draw') pD += p; else pA += p;
    if (x.h + x.a > 2) over25 += p;
    if (x.h > 0 && x.a > 0) btts += p;
    if (p > bestBy[k].p) bestBy[k] = { p, h: x.h, a: x.a };
  });
  return { pH, pD, pA, over25, btts, bestBy };
}
const leadOf = (g) => (g.pH >= g.pD && g.pH >= g.pA ? 'home' : g.pA >= g.pD ? 'away' : 'draw');

/* ---------- league baselines from standings (all derived from API data) ---------- */
function leagueAgg(rows) {
  const t = { hp: 0, hg: 0, ap: 0, ag: 0, pl: 0, dr: 0 };
  rows.forEach((r) => {
    if (!r.home || !r.away || !r.all) return;
    t.hp += r.home.played; t.hg += r.home.goals.for;
    t.ap += r.away.played; t.ag += r.away.goals.for;
    t.pl += r.all.played; t.dr += r.all.draw;
  });
  return t;
}
function baselineOf(ld) {
  if (!ld) return null;
  const g = ld.agg;
  if (g.hp < CONFIG.MIN_LEAGUE_MATCHES || g.ap < CONFIG.MIN_LEAGUE_MATCHES || !g.hg || !g.ag || !g.pl) return null;
  const lgHomeGF = g.hg / g.hp, lgAwayGF = g.ag / g.ap, drawRate = g.dr / g.pl;
  const cal = clamp(drawRate / poissonDrawProb(lgHomeGF, lgAwayGF), CONFIG.DRAW_CAL_MIN, CONFIG.DRAW_CAL_MAX);
  return { lgHomeGF, lgAwayGF, drawRate, cal, matches: g.hp, pooled: !!ld.pooled };
}

/* ---------- team ratings relative to own league ---------- */
function computeRatios(s, matchStart) {
  const b = s.base, st = s.stand, K = CONFIG.SHRINK_K;
  const sh = (ratio, n) => (n * ratio + K) / (n + K);          // shrink toward 1.0 = league average
  const rate = (g, n) => (n > 0 ? g / n : 0);
  const nH = st.home.played, nA = st.away.played;
  const r = {
    nH, nA,
    atkH: sh(rate(st.home.goals.for, nH) / b.lgHomeGF, nH),
    defH: sh(rate(st.home.goals.against, nH) / b.lgAwayGF, nH),
    atkA: sh(rate(st.away.goals.for, nA) / b.lgAwayGF, nA),
    defA: sh(rate(st.away.goals.against, nA) / b.lgHomeGF, nA),
    formAtk: null, formDef: null, formN: 0, formPool: 0,
  };
  // Opponent-adjusted, recency-weighted form from domestic league matches (opponents must be in the verified table)
  const lgAvg = (b.lgHomeGF + b.lgAwayGF) / 2;
  const table = new Map((s.ld ? s.ld.rows : []).map((x) => [x.team.id, x]));
  const dom = s.finished.filter((f) => s.league && f.league.id === s.league.id).slice(-CONFIG.FORM_WINDOW);
  r.formPool = dom.length;
  let wSum = 0, aSum = 0, dSum = 0, n = 0;
  dom.forEach((f) => {
    const p = perspective(f, s.team.id);
    const oppId = f.teams.home.id === s.team.id ? f.teams.away.id : f.teams.home.id;
    const o = table.get(oppId);
    if (!o || !o.all || o.all.played < CONFIG.MIN_OPP_GAMES) return;
    const oppConc = clamp((o.all.goals.against / o.all.played) / lgAvg, 0.5, 2);
    const oppAtk = clamp((o.all.goals.for / o.all.played) / lgAvg, 0.5, 2);
    const days = Math.max(0, (matchStart - p.ts) / 86400);
    const w = Math.pow(0.5, days / CONFIG.HALF_LIFE_DAYS);
    wSum += w; aSum += w * (p.gf / oppConc); dSum += w * (p.ga / oppAtk); n += 1;
  });
  if (n > 0) {
    r.formN = n;
    r.formAtk = sh((aSum / wSum) / lgAvg, n);
    r.formDef = sh((dSum / wSum) / lgAvg, n);
  }
  return r;
}

// mode: 'blend' | 'season' | 'form'
function expectedGoals(h, a, mode, base) {
  const W = CONFIG.SEASON_WEIGHT;
  const mix = (sv, fv) => (mode === 'season' ? sv : mode === 'form' ? fv : fv == null ? sv : W * sv + (1 - W) * fv);
  const atkH = mix(h.r.atkH, h.r.formAtk), defA = mix(a.r.defA, a.r.formDef);
  const atkA = mix(a.r.atkA, a.r.formAtk), defH = mix(h.r.defH, h.r.formDef);
  if ([atkH, defA, atkA, defH].some((x) => x == null)) return null;
  return {
    lh: clamp(base.h * atkH * defA, 0.15, 4.5),
    la: clamp(base.a * atkA * defH, 0.15, 4.5),
    atkH, defA, atkA, defH,
  };
}

/* ---------- formatting ---------- */
function fmtEAT(ts) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: CONFIG.DISPLAY_TZ, weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts * 1000));
  return `${s} EAT`;
}
function fmtDateOnly(dateStr) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${dateStr}T00:00:00Z`));
}
const formLine = (arr) => `<span class="formline" aria-label="${esc(arr.map((x) => x.res).join(' '))}">${arr.map((x) => `<i class="${x.res}">${x.res}</i>`).join('')}</span>`;

/* =========================================================
   Data gathering
   ========================================================= */
async function findTeam(name) {
  const q = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3) throw new ApiError(`"${name}" is too short to search. Use at least 3 letters.`);
  const res = await api('/teams', { search: q });
  if (!res.length) throw new ApiError(`No team found for "${name}". Check the spelling or try the full club name.`);
  const ql = q.toLowerCase();
  return res.map((r) => {
    const n = r.team.name.toLowerCase();
    let s = 0;
    if (n === ql) s += 10; else if (n.startsWith(ql)) s += 5; else if (n.includes(ql)) s += 2;
    if (!r.team.national) s += 3;
    if (/\b(u\d{2}|women|w|ii|reserves|youth)\b/.test(n)) s -= 6;
    return { r, s };
  }).sort((a, b) => b.s - a.s)[0].r;
}

function findTarget(hFix, hId, aId, date) {
  const start = Date.parse(`${date}T00:00:00Z`) / 1000, mid = start + 43200;
  return hFix.filter((f) => {
    const ids = [f.teams.home.id, f.teams.away.id];
    return ids.includes(hId) && ids.includes(aId) && f.fixture.timestamp >= start - 86400 && f.fixture.timestamp <= start + 2 * 86400;
  }).sort((a, b) => Math.abs(a.fixture.timestamp - mid) - Math.abs(b.fixture.timestamp - mid))[0] || null;
}

// Bookmaker "Match Winner" odds -> margin-free probabilities, averaged over bookmakers.
function parseOdds(resp) {
  const books = (resp[0] && resp[0].bookmakers) || [];
  const rows = [];
  books.forEach((bk) => {
    const bet = (bk.bets || []).find((x) => x.id === 1 || /^match winner$/i.test(x.name));
    if (!bet) return;
    const v = {};
    (bet.values || []).forEach((x) => { v[String(x.value).toLowerCase()] = parseFloat(x.odd); });
    if (!(v.home > 1 && v.draw > 1 && v.away > 1)) return;
    const raw = [1 / v.home, 1 / v.draw, 1 / v.away], sum = raw[0] + raw[1] + raw[2];
    rows.push({ p: raw.map((x) => x / sum), over: sum - 1 });
  });
  if (!rows.length) return null;
  const m = (i) => avg(rows.map((r) => r.p[i]));
  return { home: m(0), draw: m(1), away: m(2), books: rows.length, margin: avg(rows.map((r) => r.over)) };
}
function parseForecast(resp) {
  const p = resp[0] && resp[0].predictions;
  if (!p || !p.percent) return null;
  const n = (x) => parseFloat(String(x).replace('%', ''));
  const out = { home: n(p.percent.home) / 100, draw: n(p.percent.draw) / 100, away: n(p.percent.away) / 100, advice: p.advice || null };
  return [out.home, out.draw, out.away].every((x) => Number.isFinite(x)) ? out : null;
}

async function gather({ homeName, awayName, date, withCoaches, withMarket }) {
  const notes = [];
  const sources = [];
  const track = (label, ok, detail) => sources.push({ label, ok, detail });

  setStatus('Validating team names...');
  const [hT, aT] = await Promise.all([findTeam(homeName), findTeam(awayName)]);
  if (hT.team.id === aT.team.id) throw new ApiError('Home and away resolve to the same team. Enter two different teams.');
  track('Team search', true, `${hT.team.name} (id ${hT.team.id}), ${aT.team.name} (id ${aT.team.id})`);

  // Season derived from the match date; free plan may restrict it.
  const derivedSeason = deriveSeason(date);
  let season = derivedSeason;
  setStatus(`Loading ${hT.team.name} fixtures for season ${season}...`);
  let hFix;
  try {
    hFix = await api('/fixtures', { team: hT.team.id, season });
  } catch (err) {
    const alt = err.plan ? parsePlanSeason(err.message) : null;
    if (alt && alt !== season) {
      notes.push(`Your plan can't access season ${season}, so the analysis uses season ${alt}. Forms and standings reflect that season, and the exact fixture could not be confirmed.`);
      season = alt;
      hFix = await api('/fixtures', { team: hT.team.id, season });
    } else throw err;
  }
  setStatus(`Loading ${aT.team.name} fixtures...`);
  const aFix = await api('/fixtures', { team: aT.team.id, season });
  track('Fixtures (season ' + season + ')', hFix.length + aFix.length > 0, `${hFix.length} + ${aFix.length} records`);

  const target = findTarget(hFix, hT.team.id, aT.team.id, date);
  const hLeague = domesticLeague(hFix);
  const aLeague = domesticLeague(aFix);

  // Standings: team rows + league-wide baselines (pooled with the previous season only if this one is too thin)
  const standings = { byTeam: {} };
  const leagueData = {};
  const sameLeague = !!(hLeague && aLeague && hLeague.id === aLeague.id);
  const leaguesToFetch = sameLeague ? [hLeague] : [hLeague, aLeague].filter(Boolean);
  let standOk = 0;
  for (const lg of leaguesToFetch) {
    setStatus(`Loading ${lg.name} standings...`);
    try {
      const resp = await api('/standings', { league: lg.id, season });
      const groups = (resp[0] && resp[0].league && resp[0].league.standings) || [];
      const ids = [hT.team.id, aT.team.id];
      const grp = groups.find((g) => g.some((r) => ids.includes(r.team.id))) || groups[0] || [];
      const ld = { id: lg.id, name: lg.name, rows: grp, agg: leagueAgg(grp), pooled: false, priorSeason: null };
      grp.forEach((r) => { standings.byTeam[r.team.id] = r; });
      if (ld.agg.hp < CONFIG.MIN_LEAGUE_MATCHES) {
        setStatus(`${lg.name}: season too young, adding previous season for league averages...`);
        try {
          const prev = await api('/standings', { league: lg.id, season: season - 1 });
          const pg = ((prev[0] && prev[0].league && prev[0].league.standings) || []).flat();
          const pa = leagueAgg(pg);
          if (pa.hp > 0) {
            Object.keys(ld.agg).forEach((k) => { ld.agg[k] += pa[k]; });
            ld.pooled = true; ld.priorSeason = season - 1;
          }
        } catch (err) { notes.push(`Previous-season table for ${lg.name} unavailable (${err.message}).`); }
      }
      leagueData[lg.id] = ld;
      standOk += 1;
    } catch (err) { notes.push(`Standings for ${lg.name} unavailable (${err.message}).`); }
  }
  track('Standings', standOk > 0, standOk ? `${standOk} league table(s)` : 'none returned');

  // Head-to-head: no `last` param, sliced locally.
  setStatus('Loading head-to-head history...');
  let h2h = [];
  try {
    const resp = await api('/fixtures/headtohead', { h2h: `${hT.team.id}-${aT.team.id}` });
    h2h = resp.filter(isFinished).sort((a, b) => a.fixture.timestamp - b.fixture.timestamp).slice(-CONFIG.H2H_WINDOW);
    track('Head-to-head', true, `${h2h.length} finished meetings used`);
  } catch (err) { notes.push(`Head-to-head unavailable (${err.message}).`); track('Head-to-head', false, err.message); }

  // Injuries
  const injuries = { home: null, away: null };
  for (const [side, t] of [['home', hT], ['away', aT]]) {
    setStatus(`Loading ${t.team.name} injury report...`);
    try {
      const resp = await api('/injuries', { team: t.team.id, season });
      if (resp.length) {
        const latest = Math.max(...resp.map((x) => new Date(x.fixture.date).getTime()));
        const seen = new Set();
        injuries[side] = resp.filter((x) => new Date(x.fixture.date).getTime() === latest)
          .filter((x) => (seen.has(x.player.id) ? false : seen.add(x.player.id)))
          .map((x) => ({ name: x.player.name, type: x.player.type, reason: x.player.reason }));
      } else injuries[side] = [];
    } catch (err) { notes.push(`Injuries for ${t.team.name} unavailable (${err.message}).`); }
  }
  track('Injuries', injuries.home !== null || injuries.away !== null,
    `${injuries.home ? injuries.home.length : '-'} / ${injuries.away ? injuries.away.length : '-'} listed (home / away)`);

  // Market odds + API-Football's own forecast (only for a confirmed, not-yet-played fixture)
  let market = null, apiForecast = null;
  const upcoming = target && target.fixture.id && !FINISHED.has(target.fixture.status.short);
  if (withMarket) {
    if (!upcoming) {
      notes.push(target ? 'Odds and forecast skipped: the fixture has already been played.' : 'Odds and forecast skipped: no confirmed fixture to look them up for.');
    } else {
      setStatus('Loading bookmaker odds...');
      try {
        market = parseOdds(await api('/odds', { fixture: target.fixture.id }));
        if (!market) notes.push('No bookmaker Match Winner odds are published for this fixture yet.');
      } catch (err) { notes.push(`Odds unavailable (${err.message}).`); }
      setStatus('Loading API-Football forecast...');
      try {
        apiForecast = parseForecast(await api('/predictions', { fixture: target.fixture.id }));
        if (!apiForecast) notes.push('API-Football has no forecast for this fixture yet.');
      } catch (err) { notes.push(`API forecast unavailable (${err.message}).`); }
    }
    track('Bookmaker odds', !!market, market ? `${market.books} bookmaker(s), avg margin ${(market.margin * 100).toFixed(1)}%` : 'not available');
    track('API forecast', !!apiForecast, apiForecast ? 'received' : 'not available');
  }

  // Managers (optional)
  const coaches = { home: null, away: null };
  if (withCoaches) {
    for (const [side, t] of [['home', hT], ['away', aT]]) {
      setStatus(`Looking up ${t.team.name} manager...`);
      try {
        const resp = await api('/coachs', { team: t.team.id });
        const cur = resp.find((c) => (c.career || []).some((x) => x.team && x.team.id === t.team.id && !x.end));
        coaches[side] = cur ? cur.name : null;
      } catch (err) { notes.push(`Manager lookup for ${t.team.name} unavailable (${err.message}).`); }
    }
    track('Managers', !!(coaches.home || coaches.away), `${coaches.home || 'unknown'} / ${coaches.away || 'unknown'}`);
  }

  return { date, season, derivedSeason, hT, aT, hFix, aFix, hLeague, aLeague, sameLeague, target, standings, leagueData, h2h, injuries, market, apiForecast, coaches, notes, sources };
}

/* =========================================================
   Analysis
   ========================================================= */
function analyze(d) {
  const matchStart = Date.parse(`${d.date}T00:00:00Z`) / 1000;
  const matchEnd = matchStart + 86400;
  const target = d.target;

  let swapped = false;
  let home = { ...d.hT, fix: d.hFix, league: d.hLeague, inj: d.injuries.home, coach: d.coaches.home };
  let away = { ...d.aT, fix: d.aFix, league: d.aLeague, inj: d.injuries.away, coach: d.coaches.away };
  if (target && target.teams.home.id === away.team.id) { [home, away] = [away, home]; swapped = true; }

  const comp = target ? target.league : null;
  const venue = target && target.fixture.venue && target.fixture.venue.name
    ? { name: target.fixture.venue.name, city: target.fixture.venue.city }
    : { name: home.venue && home.venue.name, city: home.venue && home.venue.city };

  const reasons = [];
  const prov = []; // data-integrity ledger: every model input, where it came from
  const P = (item, status, source, detail) => prov.push({ item, status, source, detail });

  [home, away].forEach((s) => {
    s.stand = d.standings.byTeam[s.team.id] || null;
    s.ld = s.league ? d.leagueData[s.league.id] || null : null;
    s.finished = s.fix.filter(isFinished).filter((f) => f.fixture.timestamp < matchStart)
      .sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
    s.form = s.finished.slice(-CONFIG.FORM_WINDOW).map((f) => perspective(f, s.team.id));
    s.formGF = avg(s.form.map((x) => x.gf)); s.formGA = avg(s.form.map((x) => x.ga));
    s.cleanSheets = s.form.filter((x) => x.ga === 0).length;
    s.failedToScore = s.form.filter((x) => x.gf === 0).length;
    const lastTs = s.finished.length ? s.finished[s.finished.length - 1].fixture.timestamp : null;
    s.restDays = lastTs ? Math.floor((matchStart - lastTs) / 86400) : null;
    s.load14 = s.fix.filter((f) => f.fixture.timestamp >= matchStart - 14 * 86400 && f.fixture.timestamp < matchStart).length;
    s.load21 = s.fix.filter((f) => f.fixture.timestamp >= matchStart - 21 * 86400 && f.fixture.timestamp < matchStart).length;
    s.next4 = s.fix.filter((f) => f.fixture.timestamp >= matchEnd && f.fixture.timestamp < matchEnd + 4 * 86400).length;
    s.base = baselineOf(s.ld);
    const split = (x) => (x && x.played ? { n: x.played, ppg: (3 * x.win + x.draw) / x.played, gf: x.goals.for / x.played, ga: x.goals.against / x.played } : null);
    s.homeSplit = s.stand ? split(s.stand.home) : null;
    s.awaySplit = s.stand ? split(s.stand.away) : null;

    const nm = s.team.name;
    if (!s.league) reasons.push(`${nm}: no domestic league could be identified from its fixtures.`);
    else if (!s.stand) reasons.push(`${nm}: no row in the ${s.league.name} table was returned.`);
    else if (!s.stand.home || !s.stand.away) reasons.push(`${nm}: the table has no home/away split.`);
    if (s.league && s.ld && !s.base) reasons.push(`${s.league.name}: league baseline unreliable (fewer than ${CONFIG.MIN_LEAGUE_MATCHES} matches, even after pooling the previous season).`);
    s.r = s.stand && s.stand.home && s.stand.away && s.base ? computeRatios(s, matchStart) : null;

    if (s.base) P(`${s.league.name} league baseline`, 'ok', 'Derived from API-Football /standings', `${s.base.matches} matches${s.base.pooled ? ` (pooled with ${s.ld.priorSeason})` : ''}; ${f1(s.base.lgHomeGF)} home / ${f1(s.base.lgAwayGF)} away goals per match; draw rate ${pct(s.base.drawRate)}`);
    if (s.r) {
      P(`${nm} venue rates`, 'ok', 'API-Football /standings', `${s.r.nH} home and ${s.r.nA} away games, shrunk toward league average with k=${CONFIG.SHRINK_K}`);
      P(`${nm} opponent-adjusted form`, s.r.formN ? 'ok' : 'warn', 'Derived from API-Football /fixtures + /standings', s.r.formN ? `${s.r.formN} of ${s.r.formPool} recent league matches usable` : 'no usable recent league matches; model uses season rates only');
    }
  });

  const sameLeague = !!(home.league && away.league && home.league.id === away.league.id);
  const sharedContinental = [...competitionsOf(home.fix, 'continental').keys()].filter((id) => competitionsOf(away.fix, 'continental').has(id));
  const sameCountry = home.team.country === away.team.country;

  let compKind = 'league';
  if (comp) {
    if (comp.country === 'World') compKind = 'continental';
    else if (NON_LEAGUE.test(comp.name)) compKind = 'cup';
  } else if (!sameLeague) {
    compKind = sameCountry ? 'cup' : 'continental';
  }
  const crossLeague = !sameLeague || compKind !== 'league';
  const dims = [];
  if (!sameLeague) dims.push('tier');
  if (compKind === 'continental') dims.push('continental');
  if (compKind === 'cup') dims.push('cup');
  if (!sameLeague) dims.push('normalized');

  const crossUnadjusted = !sameLeague;
  if (crossUnadjusted) P('Cross-league strength scale', 'warn', 'None available', 'No verified, current source on the free tier, so no quality-gap factor is assumed. Each team is rated against its own league only.');

  // ---- model ----
  const uniq = [...new Set(reasons)]; reasons.length = 0; reasons.push(...uniq);
  let ok = reasons.length === 0 && !!home.r && !!away.r;
  let main = null, grid = null, calc = null, base = null, lenses = [], final = null, marketW = 0, level = 'Low';
  if (ok) {
    base = { h: avg([home.base.lgHomeGF, away.base.lgHomeGF]), a: avg([home.base.lgAwayGF, away.base.lgAwayGF]) };
    calc = avg([home.base.cal, away.base.cal]);
    main = expectedGoals(home, away, 'blend', base);
    grid = scoreGrid(main.lh, main.la, calc);
    const lensDef = [['Season rates only', 'season'], ['Recent opponent-adjusted form', 'form']];
    lensDef.forEach(([name, mode]) => {
      const e = expectedGoals(home, away, mode, base);
      if (e) lenses.push({ name, g: scoreGrid(e.lh, e.la, calc) });
    });
    lenses.push({ name: 'Blended model', g: grid });
    P('Draw calibration', 'ok', 'Derived from league draw rate (API-Football /standings)', `level-score probabilities scaled by ${f1(calc)}`);

    final = { pH: grid.pH, pD: grid.pD, pA: grid.pA };
    if (d.market) {
      const n = d.market.books;
      marketW = n >= 5 ? 0.5 : n >= 2 ? 0.35 : 0.2;
      if (crossUnadjusted) marketW = Math.max(marketW, 0.6); // odds carry the cross-league strength information we lack
      final = {
        pH: (1 - marketW) * grid.pH + marketW * d.market.home,
        pD: (1 - marketW) * grid.pD + marketW * d.market.draw,
        pA: (1 - marketW) * grid.pA + marketW * d.market.away,
      };
      lenses.push({ name: `Bookmaker odds (${n})`, g: { pH: d.market.home, pD: d.market.draw, pA: d.market.away } });
      P('Bookmaker odds', 'ok', 'API-Football /odds', `${n} bookmaker(s), margin removed; blended at ${pct(marketW)} weight`);
    } else if (d.sources.some((x) => x.label === 'Bookmaker odds')) {
      P('Bookmaker odds', 'warn', 'API-Football /odds', target ? 'not published for this fixture; model-only probabilities' : 'skipped because no confirmed fixture was found; model-only probabilities');
    }
    if (d.apiForecast) {
      lenses.push({ name: 'API-Football forecast', g: { pH: d.apiForecast.home, pD: d.apiForecast.draw, pA: d.apiForecast.away } });
      P('API-Football forecast', 'ok', 'API-Football /predictions', 'used as a consensus lens only, not blended');
    }
  }

  // ---- confidence & coverage ----
  const checks = [
    home.form.length >= 3, away.form.length >= 3, !!home.stand, !!away.stand,
    d.h2h.length >= 1, d.injuries.home !== null && d.injuries.away !== null, !!target,
    !!d.market || !!d.apiForecast,
  ];
  const coverage = checks.filter(Boolean).length / checks.length;
  const lead = final ? leadOf({ pH: final.pH, pD: final.pD, pA: final.pA }) : null;
  const top = final ? Math.max(final.pH, final.pD, final.pA) : 0;
  if (ok) {
    level = top >= 0.55 ? 'High' : top >= 0.42 ? 'Medium' : 'Low';
    if (coverage < 0.5) level = level === 'High' ? 'Medium' : 'Low';
    const thin = Math.min(home.stand.all.played, away.stand.all.played) < 6;
    if (thin) { level = level === 'High' ? 'Medium' : level; P('Sample size', 'warn', 'API-Football /standings', 'a team has fewer than 6 league games this season; confidence capped at Medium'); }
    if (crossUnadjusted && !d.market) level = 'Low';
    if (crossUnadjusted && d.market && level === 'High') level = 'Medium';
  }
  const best = ok ? { ...grid.bestBy[lead] } : null;
  const modelLead = ok ? leadOf(grid) : null;

  return { ok, reasons, d, home, away, swapped, target, comp, compKind, venue, sameLeague, crossLeague, crossUnadjusted, dims,
    sharedContinental, main, grid, base, calc, lenses, final, lead, best, marketW, modelLead, coverage, level, prov, matchStart };
}

/* =========================================================
   Rationale writer
   ========================================================= */
function writeRationale(r) {
  const { home, away, d } = r;
  const H = esc(home.team.name), A = esc(away.team.name);
  const out = [];
  const p = (t) => `<p>${t}</p>`;
  const h3 = (t) => `<h3>${t}</h3>`;

  // 1. Fixture
  let fx = h3('Fixture details');
  if (r.target) {
    const compName = esc(r.comp.name) + (r.target.league.round ? `, ${esc(r.target.league.round)}` : '');
    fx += p(`${H} host ${A} at ${esc(r.venue.name || 'a venue not listed')}${r.venue.city ? `, ${esc(r.venue.city)}` : ''} in the ${compName}. Kick-off is ${fmtEAT(r.target.fixture.timestamp)}. API-Football lists this fixture for season ${d.season}.${r.swapped ? ' The order you entered was reversed against the official fixture list, so the home and away roles follow the schedule.' : ''}`);
  } else {
    fx += p(`API-Football returned no scheduled fixture between ${H} and ${A} around ${esc(fmtDateOnly(d.date))}. This analysis therefore treats ${H} as the home side${r.venue.name ? ` at ${esc(r.venue.name)}` : ''} and assumes a ${r.sameLeague ? 'league' : r.compKind === 'cup' ? 'domestic cup' : 'continental or one-off'} setting. Kick-off time could not be confirmed, and bookmaker odds were not looked up.`);
  }
  if (home.coach || away.coach) {
    fx += p(`On the touchline, ${H} are managed by ${esc(home.coach || 'a manager the API could not identify')} and ${A} by ${esc(away.coach || 'a manager the API could not identify')}.`);
  }
  out.push(fx);

  // 2. Standings
  const stTxt = (s) => {
    if (!s.stand) return `${esc(s.team.name)}'s league position was not available`;
    const st = s.stand, a = st.all;
    return `${esc(s.team.name)} are ${ordinal(st.rank)} in the ${esc(s.league ? s.league.name : 'league')} on ${st.points} points from ${a.played} games (${a.win}W ${a.draw}D ${a.lose}L, goal difference ${st.goalsDiff >= 0 ? '+' : ''}${st.goalsDiff})`;
  };
  let standing = h3(r.sameLeague ? 'League standings' : 'Standings in their own leagues');
  if (home.stand && away.stand && r.sameLeague) {
    const gap = Math.abs(home.stand.rank - away.stand.rank), pts = Math.abs(home.stand.points - away.stand.points);
    standing += p(`${stTxt(home)}, while ${stTxt(away)}. That is a gap of ${gap} place${gap === 1 ? '' : 's'} and ${pts} point${pts === 1 ? '' : 's'}.`);
  } else {
    standing += p(`${stTxt(home)}. ${stTxt(away)}.${!r.sameLeague && home.league && away.league ? ` These tables are not directly comparable, because ${esc(home.league.name)} and ${esc(away.league.name)} are different competitions.` : ''}`);
  }
  out.push(standing);

  // 3. Form
  let form = h3('Recent form');
  const fTxt = (s) => s.form.length
    ? `${esc(s.team.name)}: ${formLine(s.form)} (oldest to newest, last ${s.form.length}), scoring ${f1(s.formGF)} and conceding ${f1(s.formGA)} per game in all competitions.${s.r && s.r.formN ? ` Adjusted for opponent strength and recency, their recent league attack is ${s.r.formAtk >= 1 ? 'above' : 'below'} their league average (index ${f1(s.r.formAtk)}) and their defence ${s.r.formDef <= 1 ? 'better' : 'worse'} than average (index ${f1(s.r.formDef)}).` : ''}`
    : `${esc(s.team.name)}: no finished matches before this date were found for season ${d.season}.`;
  form += p(fTxt(home)) + p(fTxt(away));
  out.push(form);

  // 4. Goals & defence
  let gd = h3('Goalscoring and defensive patterns');
  const gdTxt = (s) => s.form.length
    ? `${esc(s.team.name)} kept ${s.cleanSheets} clean sheet${s.cleanSheets === 1 ? '' : 's'} and failed to score in ${s.failedToScore} of their last ${s.form.length}.${s.stand ? ` Over the season they average ${f1(s.stand.all.goals.for / s.stand.all.played)} scored and ${f1(s.stand.all.goals.against / s.stand.all.played)} conceded in the league.` : ''}`
    : '';
  gd += p(`${gdTxt(home)} ${gdTxt(away)}`.trim() || 'Not enough match data to describe scoring and defensive patterns.');
  out.push(gd);

  // 5. H2H
  let h2 = h3('Head-to-head');
  if (d.h2h.length) {
    let hw = 0, aw = 0, dr = 0, hg = 0, ag = 0;
    d.h2h.forEach((f) => {
      const x = perspective(f, home.team.id);
      hg += x.gf; ag += x.ga;
      if (x.res === 'W') hw++; else if (x.res === 'L') aw++; else dr++;
    });
    const lastF = d.h2h[d.h2h.length - 1];
    const lp = perspective(lastF, home.team.id);
    h2 += p(`In their last ${d.h2h.length} meetings, ${H} won ${hw}, ${A} won ${aw} and ${dr} ended level, with a combined goal tally of ${hg}-${ag} (${H} first). The latest meeting was ${esc(lp.comp)} on ${esc(new Date(lastF.fixture.timestamp * 1000).toISOString().slice(0, 10))}, a ${lp.gf}-${lp.ga} ${lp.res === 'W' ? 'win' : lp.res === 'L' ? 'loss' : 'draw'} for ${H}. Head-to-head is shown for context and is not an input to the model.`);
  } else {
    h2 += p('The two clubs have no recorded meetings in API-Football\'s head-to-head data.');
  }
  out.push(h2);

  // 6. Injuries
  let inj = h3('Injuries and availability');
  const iTxt = (s) => {
    if (s.inj === null) return `${esc(s.team.name)}: injury data could not be loaded.`;
    if (!s.inj.length) return `${esc(s.team.name)}: no injuries are listed for their most recent fixture.`;
    const names = s.inj.slice(0, 6).map((x) => `${esc(x.name)}${x.reason ? ` (${esc(x.reason)})` : ''}`).join(', ');
    return `${esc(s.team.name)}: ${s.inj.length} player${s.inj.length === 1 ? '' : 's'} listed, including ${names}.`;
  };
  inj += p(`${iTxt(home)} ${iTxt(away)} API-Football's injury feed often lags team news, and the model does not weight individual players, so check the final line-ups.`);
  out.push(inj);

  // 7. Schedule & stakes (reported, not modelled)
  let sk = h3('Schedule and stakes');
  const sTxt = (s) => {
    const bits = [];
    if (s.restDays != null) bits.push(`${s.restDays} day${s.restDays === 1 ? '' : 's'} since their last match`);
    bits.push(`${s.load14} match${s.load14 === 1 ? '' : 'es'} in the previous 14 days`);
    if (s.next4) bits.push(`${s.next4} more within 4 days after`);
    const note = s.stand && s.stand.description ? ` The table marks their position as "${esc(s.stand.description)}".` : '';
    const left = s.ld && s.ld.rows.length >= 8 && !s.ld.pooled && s.stand ? 2 * (s.ld.rows.length - 1) - s.stand.all.played : null;
    return `${esc(s.team.name)}: ${bits.join(', ')}.${left != null && left >= 0 ? ` About ${left} league games remain.` : ''}${note}`;
  };
  sk += p(`${sTxt(home)} ${sTxt(away)} These are shown for your judgement. They are not applied to the numbers, because the free data gives no verified measure of how much they shift results.`);
  out.push(sk);

  if (r.sameLeague) {
    let ha = h3('Home advantage');
    const hs = home.homeSplit, as = away.awaySplit;
    if (hs && as) {
      ha += p(`${H} take ${f1(hs.ppg)} points per home league game (${hs.n} played), scoring ${f1(hs.gf)} and conceding ${f1(hs.ga)}. ${A} take ${f1(as.ppg)} per away league game (${as.n} played), scoring ${f1(as.gf)} and conceding ${f1(as.ga)}. ${hs.ppg - as.ppg > 0.4 ? 'The venue split favours the hosts clearly.' : hs.ppg - as.ppg < -0.4 ? 'The visitors travel unusually well, which cuts against the usual home edge.' : 'The venue split is modest, so home advantage matters less than usual.'} The model uses these real venue records directly instead of a flat home bonus.`);
    } else {
      ha += p('There were no home and away league records for one of the teams, so no venue split could be described.');
    }
    out.push(ha);
  }

  if (r.crossLeague) {
    const lead = r.ok ? r.lead : null;
    const favIsHome = lead === 'home' || (lead === 'draw' && r.final.pH >= r.final.pA);
    const fav = favIsHome ? home : away, dog = favIsHome ? away : home;
    const F = esc(fav.team.name), D = esc(dog.team.name);

    if (r.dims.includes('tier')) {
      let t = h3('Cross-tier dynamics');
      t += p(`${esc(home.league ? home.league.name : H)} and ${esc(away.league ? away.league.name : A)} are different competitions. The free API provides no verified measure of how strong each is, so the model does not assume a quality gap from league names. It rates each team against its own league only${r.ok && d.market ? `, and gives bookmaker odds extra weight (${pct(r.marketW)}) because prices reflect squad quality across divisions` : ', and lowers its confidence accordingly'}.`);
      if (r.ok) {
        t += p(`${d.market ? `The odds favour ${F}.` : `Without odds, the model's lean towards ${F} comes only from each team's record inside its own league, so treat it as indicative.`} Rotation risk: ${F} played ${fav.load21} match${fav.load21 === 1 ? '' : 'es'} in the 21 days before this date and ${D} ${dog.load21}.${fav.load21 >= 6 ? ` That is a heavy load, so a rotated ${F} line-up is plausible.` : ' That is a manageable load.'}`);
        const dd = dog.r;
        t += p(`In their own league, ${D}'s defence index is ${f1(dd.defA)} away and ${f1(dd.defH)} at home (1.00 is league average, lower is better), and their attack index is ${f1(dd.atkA)} away and ${f1(dd.atkH)} at home. Those figures are measured against weaker or stronger opposition than ${F} face, so they carry less weight in a cross-league tie.`);
      }
      out.push(t);
    }

    if (r.dims.includes('continental')) {
      let c = h3('Continental dynamics');
      const rnd = r.target && r.target.league.round ? r.target.league.round : null;
      c += p(`${r.comp ? `This is listed as a ${esc(r.comp.name)} fixture${rnd ? ` (${esc(rnd)})` : ''}.` : 'No official listing was found, so a continental setting is assumed from the clubs\' countries.'} ${home.team.country !== away.team.country ? `Travel from ${esc(away.team.country || 'abroad')} to ${esc(home.team.country || 'the host country')} adds fatigue and unfamiliar conditions for ${A}.` : 'Both clubs are from the same country, so travel is not a factor.'}`);
      c += p(`${rnd && /leg|round of|quarter|semi|play-?off/i.test(rnd) ? 'Knockout ties can be played over two legs, where aggregate scoring shapes how cautiously each side starts.' : 'Stakes depend on the stage of the tournament. Group or league-phase games reward risk less than knockout ties.'} The model predicts the 90-minute scoreline only.`);
      out.push(c);
    }

    if (r.dims.includes('cup')) {
      let c = h3('Domestic cup dynamics');
      const rnd = r.target && r.target.league.round ? r.target.league.round : null;
      c += p(`${r.comp ? `The fixture is listed in the ${esc(r.comp.name)}${rnd ? `, ${esc(rnd)}` : ''}.` : 'No official listing was found, so a domestic cup tie is assumed because the clubs play in different divisions of the same country.'} If the score is level after 90 minutes, extra time and a penalty shootout may follow, depending on the competition and round. Some cups use replays or go straight to penalties in early rounds. Check the rules for this one.`);
      if (r.ok) c += p(`Fixture congestion: ${F} played ${fav.load21} and ${D} played ${dog.load21} matches in the prior 21 days. Cup ties often see changes to the starting XI, which can narrow any quality gap. The score shown is a 90-minute scoreline.`);
      out.push(c);
    }

    if (r.dims.includes('normalized') && r.ok) {
      let n = h3('League-relative statistics');
      const m = r.main;
      n += p(`To compare teams from different divisions without inventing a conversion between them, each side's rates are expressed as an index against its own league's average (1.00 means average). Rates are shrunk toward 1.00 for small samples. The resulting expected goals for this match are ${f1(m.lh)} for ${H} and ${f1(m.la)} for ${A}.`);
      const row = (s) => `<tr><td>${esc(s.team.name)}</td><td>${esc(s.league.name)}</td><td>${f1(s.r.atkH)} / ${f1(s.r.atkA)}</td><td>${f1(s.r.defH)} / ${f1(s.r.defA)}</td><td>${s.r.formAtk == null ? 'n/a' : f1(s.r.formAtk)}</td><td>${s.r.formDef == null ? 'n/a' : f1(s.r.formDef)}</td></tr>`;
      n += `<div class="tablewrap"><table class="norm"><thead><tr><th>Team</th><th>League</th><th>Attack (home / away)</th><th>Defence (home / away)</th><th>Form attack</th><th>Form defence</th></tr></thead><tbody>${row(home)}${row(away)}</tbody></table></div>`;
      n += p('For defence, lower is better. These indices are measured inside different leagues, so they show relative strength within each league, not strength between leagues.');
      out.push(n);
    }
  }

  // 8. Model view
  if (r.ok) {
    const g = r.final;
    let mv = h3('How the prediction was reached');
    mv += p(`Each team's goal rates come from its league table split by home and away, blended ${pct(CONFIG.SEASON_WEIGHT)} with ${pct(1 - CONFIG.SEASON_WEIGHT)} opponent-adjusted, recency-weighted recent form, and shrunk toward its league average. That gives expected goals of ${f1(r.main.lh)} for ${H} and ${f1(r.main.la)} for ${A}. A Poisson scoreline model, with level scores calibrated to the league's real draw rate, gives ${pct(r.grid.pH)} for ${H} to win, ${pct(r.grid.pD)} for a draw and ${pct(r.grid.pA)} for ${A} to win.`);
    if (d.market) mv += p(`Blending in bookmaker probabilities at ${pct(r.marketW)} weight (${d.market.books} bookmaker${d.market.books === 1 ? '' : 's'}, margin removed) moves this to ${pct(g.pH)}, ${pct(g.pD)} and ${pct(g.pA)}.`);
    mv += p(`The predicted score, ${r.best.h}-${r.best.a}, is the likeliest scoreline within the likeliest outcome.`);
    out.push(mv);
  } else {
    out.push(h3('Why there is no score') + p(`The model refused to produce a number. ${r.reasons.map(esc).join(' ')} It does not fill gaps with assumed averages, because a guess would look like a prediction.`));
  }

  return out.join('');
}

/* =========================================================
   Prediction log (local backtesting)
   ========================================================= */
const Log = {
  load() { try { return JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]'); } catch { return []; } },
  save(a) { try { localStorage.setItem(CONFIG.LOG_KEY, JSON.stringify(a.slice(-200))); return true; } catch { return false; } },
  record(r) {
    if (!r.ok || !r.target || !r.target.fixture.id) return false;
    const all = Log.load().filter((e) => e.fid !== r.target.fixture.id);
    all.push({
      fid: r.target.fixture.id, ts: r.target.fixture.timestamp, home: r.home.team.name, away: r.away.team.name,
      pH: r.final.pH, pD: r.final.pD, pA: r.final.pA, pick: r.lead, score: `${r.best.h}-${r.best.a}`,
      market: !!r.d.market, cross: r.crossLeague, made: Date.now(), actual: null,
    });
    return Log.save(all);
  },
  stats() {
    const s = Log.load().filter((e) => e.actual);
    if (!s.length) return null;
    const hit = s.filter((e) => e.pick === e.actual.outcome).length;
    const brier = avg(s.map((e) => {
      const o = { home: 0, draw: 0, away: 0 }; o[e.actual.outcome] = 1;
      return (e.pH - o.home) ** 2 + (e.pD - o.draw) ** 2 + (e.pA - o.away) ** 2;
    }));
    return { n: s.length, acc: hit / s.length, brier, exact: s.filter((e) => e.score === `${e.actual.h}-${e.actual.a}`).length };
  },
};

async function settleLog() {
  const all = Log.load();
  const cutoff = Date.now() - 3 * 3600 * 1000;
  const pending = all.filter((e) => !e.actual && e.ts * 1000 < cutoff).slice(0, 20);
  if (!pending.length) { setStatus('No logged matches are ready to check yet. Matches settle about 3 hours after kick-off.', false); return; }
  setStatus(`Checking ${pending.length} logged match${pending.length === 1 ? '' : 'es'}...`);
  try {
    const resp = await api('/fixtures', { ids: pending.map((e) => e.fid).join('-') });
    let n = 0;
    resp.forEach((f) => {
      if (!isFinished(f)) return;
      const e = all.find((x) => x.fid === f.fixture.id);
      if (!e) return;
      e.actual = { h: f.goals.home, a: f.goals.away, outcome: f.goals.home > f.goals.away ? 'home' : f.goals.home < f.goals.away ? 'away' : 'draw' };
      n += 1;
    });
    Log.save(all);
    setStatus(n ? `Settled ${n} match${n === 1 ? '' : 'es'}.` : 'None of the logged matches have a final result yet.', false);
  } catch (err) { setStatus(null); showError(err.message); }
  renderLog();
}

function renderLog() {
  const el = $('#log');
  const all = Log.load();
  if (!all.length) { el.innerHTML = ''; return; }
  const st = Log.stats();
  const rows = all.slice().reverse().slice(0, 12).map((e) => {
    const out = e.actual ? `${e.actual.h}-${e.actual.a}` : 'pending';
    const hit = e.actual ? (e.pick === e.actual.outcome ? '<span class="ok">hit</span>' : '<span class="bad">miss</span>') : '';
    const pk = e.pick === 'home' ? e.home : e.pick === 'away' ? e.away : 'Draw';
    return `<tr><td>${esc(e.home)} v ${esc(e.away)}</td><td>${esc(pk)} (${pct(Math.max(e.pH, e.pD, e.pA))})</td><td>${esc(e.score)}</td><td>${esc(out)} ${hit}</td></tr>`;
  }).join('');
  el.innerHTML = `<section class="block"><h2>Prediction log</h2>
    <div class="card">
      <p style="margin:0 0 8px;font-size:.92rem">${st ? `${st.n} settled: outcome accuracy ${pct(st.acc)}, exact scores ${st.exact}, Brier score ${st.brier.toFixed(3)} (lower is better; always guessing 1/3 each scores 0.667).` : 'Predictions for confirmed fixtures are saved in this browser. Check results after the matches to see how the model performs.'}</p>
      <div class="tablewrap"><table class="norm"><thead><tr><th>Match</th><th>Pick</th><th>Score</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button id="settle" type="button" class="secondary">Check finished matches</button>
      <button id="clearlog" type="button" class="secondary">Clear log</button>
    </div></section>`;
  $('#settle').addEventListener('click', settleLog);
  $('#clearlog').addEventListener('click', () => { Log.save([]); renderLog(); });
}

/* =========================================================
   Rendering
   ========================================================= */
function render(r) {
  const { home, away, d } = r;
  const cmpLabel = r.target ? `${r.comp.name}${r.target.league.round ? ' · ' + r.target.league.round : ''}` : (r.sameLeague && home.league ? `${home.league.name} (assumed)` : 'Competition unconfirmed');
  const when = r.target ? fmtEAT(r.target.fixture.timestamp) : `${fmtDateOnly(d.date)} (kick-off time unconfirmed)`;
  const typeLabel = r.sameLeague && r.compKind === 'league' ? 'Same-league fixture' : 'Cross-league fixture';
  const metaBlock = `<div class="meta">
        <div>${esc(typeLabel)}: ${esc(cmpLabel)}</div>
        <div>Venue: ${esc(r.venue.name || 'not listed')}${r.venue.city ? ', ' + esc(r.venue.city) : ''}</div>
        <div>Kick-off: ${esc(when)}</div>
      </div>`;
  const crest = (t) => (t.logo ? `<img class="crest" src="${esc(t.logo)}" alt="" onerror="this.remove()">` : '');

  let s1;
  if (r.ok) {
    const g = r.final;
    s1 = `<div class="board">
      <div class="teams">
        <div class="team">${crest(home.team)}<b>${esc(home.team.name)}</b><span>Home</span></div>
        <div class="digits" aria-label="Predicted score ${r.best.h} to ${r.best.a}"><span class="cell">${r.best.h}</span><span class="sep">-</span><span class="cell">${r.best.a}</span></div>
        <div class="team away">${crest(away.team)}<b>${esc(away.team.name)}</b><span>Away</span></div>
      </div>
      ${metaBlock}
      <span class="conf ${r.level}">Confidence: ${r.level}</span>
      <div class="odds">
        <div class="strip" role="img" aria-label="Win probabilities"><i class="h" style="width:${g.pH * 100}%"></i><i class="d" style="width:${g.pD * 100}%"></i><i class="a" style="width:${g.pA * 100}%"></i></div>
        <div class="labels"><span>${esc(home.team.name)} ${pct(g.pH)}</span><span>Draw ${pct(g.pD)}</span><span>${esc(away.team.name)} ${pct(g.pA)}</span></div>
      </div>
      <div class="chips">
        <span>Expected goals ${f1(r.main.lh)} - ${f1(r.main.la)}</span>
        <span>Over 2.5 goals ${pct(r.grid.over25)}</span>
        <span>Both teams score ${pct(r.grid.btts)}</span>
        <span>Chance of exactly ${r.best.h}-${r.best.a}: ${pct(r.best.p)}</span>
      </div>
    </div>`;
  } else {
    s1 = `<div class="board nodata">
      <div class="teams">
        <div class="team">${crest(home.team)}<b>${esc(home.team.name)}</b><span>Home</span></div>
        <div class="digits" aria-label="No prediction"><span class="cell">?</span><span class="sep">-</span><span class="cell">?</span></div>
        <div class="team away">${crest(away.team)}<b>${esc(away.team.name)}</b><span>Away</span></div>
      </div>
      ${metaBlock}
      <span class="conf Low">No prediction: insufficient verified data</span>
      <ul class="why">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="why-note">The model will not substitute assumed averages for missing data.</p>
    </div>`;
  }

  const lensRows = r.lenses.map((l) => {
    const w = leadOf(l.g);
    const txt = w === 'home' ? `${home.team.name} win` : w === 'away' ? `${away.team.name} win` : 'Draw';
    return `<li>${esc(l.name)}: ${esc(txt)} (${pct(Math.max(l.g.pH, l.g.pD, l.g.pA))})</li>`;
  }).join('');
  const leaders = r.lenses.map((l) => leadOf(l.g));
  const nAgree = r.ok ? leaders.filter((x) => x === r.lead).length : 0;
  const consensus = r.ok
    ? `${nAgree} of ${leaders.length} views agree with the final call (${r.lead === 'draw' ? 'a draw' : (r.lead === 'home' ? home.team.name : away.team.name) + ' to win'}).${nAgree < leaders.length ? ' The disagreement is why confidence is held down.' : ''}`
    : 'No consensus: the model could not run.';

  const srcRows = d.sources.map((s) => `<li><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? 'OK' : 'Missing'}</span> ${esc(s.label)}: ${esc(s.detail)}</li>`).join('');
  const provRows = r.prov.map((x) => `<li><span class="${x.status === 'ok' ? 'ok' : 'warn'}">${x.status === 'ok' ? 'Verified' : 'Gap'}</span> ${esc(x.item)}: ${esc(x.detail)} <small>(${esc(x.source)})</small></li>`).join('');
  const assumptions = [
    `Form half-life ${CONFIG.HALF_LIFE_DAYS} days`, `Shrinkage: ${CONFIG.SHRINK_K} pseudo-games of league average`,
    `Season/form blend ${pct(CONFIG.SEASON_WEIGHT)} / ${pct(1 - CONFIG.SEASON_WEIGHT)}`, 'Bookmaker blend weight 20-60% by number of bookmakers (60% minimum for cross-league)',
  ].map((x) => `<li>${esc(x)}</li>`).join('');
  const limits = [
    'Free plan: 10 requests per minute, 100 per day, and access limited to certain seasons.',
    'Injury data can lag real team news and is not weighted by player importance.',
    'No verified cross-league strength scale exists on the free tier, so cross-league scorelines are indicative.',
    'Rest days, stakes, lineups, weather and shot-based xG are not applied to the numbers.',
    ...d.notes,
  ].map((x) => `<li>${esc(x)}</li>`).join('');

  $('#results').innerHTML = `
  <section class="block" aria-labelledby="s1">
    <h2 id="s1">Independent match prediction</h2>
    ${s1}
  </section>

  <section class="block" aria-labelledby="s2">
    <h2 id="s2">Prediction rationale</h2>
    <div class="prose">${writeRationale(r)}</div>
  </section>

  <section class="block" aria-labelledby="s3">
    <h2 id="s3">Prediction consensus and metadata</h2>
    <div class="meta-grid">
      <div class="card"><h3>Live data sources</h3>
        <ul><li>API-Football (api-sports.io), season ${d.season}${d.season !== d.derivedSeason ? ` (derived ${d.derivedSeason}, plan fallback)` : ' (derived from match date)'}</li>${srcRows}<li>${stats.requests} API requests used in this run</li></ul>
      </div>
      <div class="card"><h3>Coverage</h3>
        <ul><li>Data coverage: ${pct(r.coverage)} of key inputs found</li><li>Form window: last ${CONFIG.FORM_WINDOW} matches (sliced locally, no <code>last</code> parameter)</li><li>Head-to-head window: last ${CONFIG.H2H_WINDOW} meetings (sliced locally)</li></ul>
      </div>
      <div class="card wide"><h3>Data integrity: where each input came from</h3>
        <ul>${provRows || '<li>No model inputs were verified.</li>'}</ul>
        <p class="small">Every number in the model is measured or derived from API data. Where data is missing the model abstains or says so. It does not insert assumed values.</p>
        <h3 style="margin-top:12px">Modelling choices (settings, not data)</h3><ul>${assumptions}</ul>
      </div>
      <div class="card wide"><h3>Model consensus view</h3>
        <ul>${lensRows || '<li>No views available.</li>'}</ul>
        <p style="margin:10px 0 0;font-size:.92rem">${esc(consensus)}</p>
      </div>
      <div class="card wide"><h3>Platform limitations</h3><ul>${limits}</ul></div>
    </div>
  </section>`;
}

/* =========================================================
   UI wiring
   ========================================================= */
function showError(msg) {
  const el = $('#error');
  if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<strong>Analysis could not finish</strong>${esc(msg)}`;
}

async function run() {
  const homeName = $('#home').value.trim();
  const awayName = $('#away').value.trim();
  const date = $('#date').value;
  if (!homeName || !awayName) return showError('Enter both a home team and an away team.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showError('Pick a match date.');

  showError(null);
  $('#results').innerHTML = '';
  stats.requests = 0;
  const btn = $('#run');
  btn.disabled = true; btn.textContent = 'Analysing...';
  try {
    const data = await gather({ homeName, awayName, date, withCoaches: $('#coaches').checked, withMarket: $('#market').checked });
    setStatus('Building prediction...');
    const result = analyze(data);
    render(result);
    Log.record(result);
    renderLog();
    setStatus(null);
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(null);
    showError(err instanceof ApiError ? err.message : `Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Run Deep Analysis';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#date').value = new Date().toLocaleDateString('en-CA');
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  renderLog();
});
