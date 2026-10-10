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
  MAX_PER_MINUTE: 9,          // free plan allows 10/min; stay one under
  DISPLAY_TZ: 'Africa/Nairobi', // East Africa Time (EAT, UTC+3)
  FORM_WINDOW: 6,
  H2H_WINDOW: 10,
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

// Heuristic league-strength coefficients (0-1). Used only to normalise cross-league stats.
const LEAGUE_STRENGTH = {
  39: 1.0, 140: 0.97, 135: 0.95, 78: 0.95, 61: 0.88, 88: 0.78, 94: 0.78, 144: 0.68, 203: 0.68,
  71: 0.70, 128: 0.66, 253: 0.62, 307: 0.60, 179: 0.62, 40: 0.68, 41: 0.55, 42: 0.48, 43: 0.42,
  136: 0.60, 141: 0.60, 79: 0.60, 62: 0.55, 218: 0.60, 207: 0.60, 197: 0.58, 119: 0.60, 113: 0.55,
  103: 0.55, 106: 0.52, 345: 0.52, 210: 0.52, 235: 0.60,
};
const leagueStrength = (league) => (league && LEAGUE_STRENGTH[league.id]) || 0.5;
const ratingFactor = (s) => Math.pow(s, 0.7);

/* ---------- Poisson model ---------- */
function poissonP(l, k) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}
function scoreGrid(lh, la) {
  const M = 8;
  let pH = 0, pD = 0, pA = 0, over25 = 0, btts = 0, total = 0;
  let best = { p: -1, h: 0, a: 0 };
  for (let h = 0; h <= M; h++) {
    for (let a = 0; a <= M; a++) {
      const p = poissonP(lh, h) * poissonP(la, a);
      total += p;
      if (h > a) pH += p; else if (h === a) pD += p; else pA += p;
      if (h + a > 2) over25 += p;
      if (h > 0 && a > 0) btts += p;
      if (p > best.p) best = { p, h, a };
    }
  }
  return { pH: pH / total, pD: pD / total, pA: pA / total, over25: over25 / total, btts: btts / total, best };
}
// H, A = { gf, ga, f } -> expected goals on a league-normalised scale
function lambdas(H, A) {
  const atkH = H.gf * H.f, concH = H.ga / H.f;
  const atkA = A.gf * A.f, concA = A.ga / A.f;
  return {
    lh: clamp(((atkH + concA) / 2) * 1.10, 0.2, 4.2),
    la: clamp(((atkA + concH) / 2) * 0.92, 0.2, 4.2),
    atkH, concH, atkA, concA,
  };
}
const leader = (g) => (g.pH >= g.pD && g.pH >= g.pA ? 'home' : g.pA >= g.pD ? 'away' : 'draw');

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

function pickStanding(resp, teamId) {
  const groups = (resp[0] && resp[0].league && resp[0].league.standings) || [];
  for (const g of groups) for (const row of g) if (row.team.id === teamId) return row;
  return null;
}

async function gather({ homeName, awayName, date, withCoaches }) {
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

  const hLeague = domesticLeague(hFix);
  const aLeague = domesticLeague(aFix);

  // Standings (one call if the same league)
  const standings = { home: null, away: null };
  const sameLeague = !!(hLeague && aLeague && hLeague.id === aLeague.id);
  const leaguesToFetch = sameLeague ? [hLeague] : [hLeague, aLeague].filter(Boolean);
  let standOk = 0;
  for (const lg of leaguesToFetch) {
    setStatus(`Loading ${lg.name} standings...`);
    try {
      const resp = await api('/standings', { league: lg.id, season });
      const hs = pickStanding(resp, hT.team.id), as = pickStanding(resp, aT.team.id);
      if (hs) standings.home = hs;
      if (as) standings.away = as;
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

  return { date, season, derivedSeason, hT, aT, hFix, aFix, hLeague, aLeague, sameLeague, standings, h2h, injuries, coaches, notes, sources };
}

/* =========================================================
   Analysis
   ========================================================= */
function analyze(d) {
  const matchStart = Date.parse(`${d.date}T00:00:00Z`) / 1000;
  const matchEnd = matchStart + 86400;

  // Locate the scheduled fixture (home team's list contains the opponent on that date)
  let target = d.hFix.filter((f) => {
    const ids = [f.teams.home.id, f.teams.away.id];
    return ids.includes(d.hT.team.id) && ids.includes(d.aT.team.id) &&
      f.fixture.timestamp >= matchStart - 86400 && f.fixture.timestamp <= matchEnd + 86400;
  }).sort((a, b) => Math.abs(a.fixture.timestamp - (matchStart + 43200)) - Math.abs(b.fixture.timestamp - (matchStart + 43200)))[0] || null;

  let swapped = false;
  let home = { ...d.hT, fix: d.hFix, league: d.hLeague, stand: d.standings.home, inj: d.injuries.home, coach: d.coaches.home };
  let away = { ...d.aT, fix: d.aFix, league: d.aLeague, stand: d.standings.away, inj: d.injuries.away, coach: d.coaches.away };
  if (target && target.teams.home.id === away.team.id) { [home, away] = [away, home]; swapped = true; }

  const comp = target ? target.league : null;
  const venue = target && target.fixture.venue && target.fixture.venue.name
    ? { name: target.fixture.venue.name, city: target.fixture.venue.city }
    : { name: home.venue && home.venue.name, city: home.venue && home.venue.city };

  // Per-team form and metrics
  [home, away].forEach((s) => {
    s.finished = s.fix.filter(isFinished).filter((f) => f.fixture.timestamp < matchStart)
      .sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
    s.form = s.finished.slice(-CONFIG.FORM_WINDOW).map((f) => perspective(f, s.team.id));
    s.domFinished = s.finished.filter((f) => s.league && f.league.id === s.league.id).map((f) => perspective(f, s.team.id));
    s.formGF = avg(s.form.map((x) => x.gf)); s.formGA = avg(s.form.map((x) => x.ga));
    s.cleanSheets = s.form.filter((x) => x.ga === 0).length;
    s.failedToScore = s.form.filter((x) => x.gf === 0).length;
    const all = s.stand && s.stand.all;
    s.seasonGF = all && all.played ? all.goals.for / all.played : null;
    s.seasonGA = all && all.played ? all.goals.against / all.played : null;
    const fb = avg(s.finished.slice(-10).map((f) => perspective(f, s.team.id).gf));
    const fbA = avg(s.finished.slice(-10).map((f) => perspective(f, s.team.id).ga));
    const blend = (a, b, c) => (a != null && b != null ? 0.6 * a + 0.4 * b : a != null ? a : b != null ? b : c);
    s.gf = blend(s.seasonGF, s.formGF, fb);
    s.ga = blend(s.seasonGA, s.formGA, fbA);
    s.noData = s.gf == null || s.ga == null;
    if (s.noData) { s.gf = 1.3; s.ga = 1.3; }
    s.strength = leagueStrength(s.league);
    s.f = ratingFactor(s.strength);
    s.homeSplit = (() => { const r = s.domFinished.filter((x) => x.home); return r.length ? { n: r.length, ppg: avg(r.map((x) => (x.res === 'W' ? 3 : x.res === 'D' ? 1 : 0))), gf: avg(r.map((x) => x.gf)), ga: avg(r.map((x) => x.ga)) } : null; })();
    s.awaySplit = (() => { const r = s.domFinished.filter((x) => !x.home); return r.length ? { n: r.length, ppg: avg(r.map((x) => (x.res === 'W' ? 3 : x.res === 'D' ? 1 : 0))), gf: avg(r.map((x) => x.gf)), ga: avg(r.map((x) => x.ga)) } : null; })();
    s.load21 = s.fix.filter((f) => f.fixture.timestamp >= matchStart - 21 * 86400 && f.fixture.timestamp < matchStart).length;
  });

  // Context detection
  const sameLeague = !!(home.league && away.league && home.league.id === away.league.id);
  const sharedContinental = [...competitionsOf(home.fix, 'continental').keys()].filter((id) => competitionsOf(away.fix, 'continental').has(id));
  const sharedCups = [...competitionsOf(home.fix, 'cup').keys()].filter((id) => competitionsOf(away.fix, 'cup').has(id));
  const sameCountry = home.team.country === away.team.country;

  let compKind = 'league';
  if (comp) {
    if (comp.country === 'World') compKind = 'continental';
    else if (NON_LEAGUE.test(comp.name)) compKind = 'cup';
  } else if (!sameLeague) {
    compKind = sameCountry ? 'cup' : 'continental';
  }
  const compAssumed = !comp && !sameLeague;
  const strengthGap = Math.abs(home.strength - away.strength);
  const crossLeague = !sameLeague || compKind !== 'league';
  const dims = [];
  if (!sameLeague && (compKind === 'cup' || strengthGap >= 0.12 || sameCountry)) dims.push('tier');
  if (compKind === 'continental') dims.push('continental');
  if (compKind === 'cup') dims.push('cup');
  if (!sameLeague) dims.push('normalized');
  if (!sameLeague && !dims.includes('tier')) dims.unshift('tier');

  // Predictions: blended (main) + season-only + form-only lenses
  const mk = (gfKey, gaKey, s) => ({ gf: s[gfKey], ga: s[gaKey], f: s.f });
  const main = lambdas(home, away);
  const grid = scoreGrid(main.lh, main.la);
  const lenses = [];
  const lensGrid = (a, b) => { const l = lambdas(a, b); return scoreGrid(l.lh, l.la); };
  if (home.seasonGF != null && away.seasonGF != null) lenses.push({ name: 'Season averages', g: lensGrid(mk('seasonGF', 'seasonGA', home), mk('seasonGF', 'seasonGA', away)) });
  if (home.formGF != null && away.formGF != null) lenses.push({ name: 'Recent form', g: lensGrid(mk('formGF', 'formGA', home), mk('formGF', 'formGA', away)) });
  lenses.push({ name: 'Blended model', g: grid });

  // Coverage & confidence
  const checks = [
    home.form.length >= 3, away.form.length >= 3, !!home.stand || home.seasonGF != null, !!away.stand || away.seasonGF != null,
    d.h2h.length >= 1, d.injuries.home !== null && d.injuries.away !== null, !!target,
  ];
  const coverage = checks.filter(Boolean).length / checks.length;
  const top = Math.max(grid.pH, grid.pD, grid.pA);
  let level = top >= 0.55 ? 'High' : top >= 0.42 ? 'Medium' : 'Low';
  if (coverage < 0.45) level = level === 'High' ? 'Medium' : 'Low';
  if (home.noData || away.noData) level = 'Low';

  return { d, home, away, swapped, target, comp, compKind, compAssumed, venue, sameLeague, crossLeague, dims, strengthGap,
    sharedContinental, sharedCups, main, grid, lenses, coverage, level, matchStart };
}

/* =========================================================
   Rationale writer
   ========================================================= */
function writeRationale(r) {
  co
