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
  const bestBy = { home: { p: -1, h: 1, a: 0 }, draw: { p: -1, h: 1, a: 1 }, away: { p: -1, h: 0, a: 1 } };
  for (let h = 0; h <= M; h++) {
    for (let a = 0; a <= M; a++) {
      const p = poissonP(lh, h) * poissonP(la, a);
      total += p;
      const k = h > a ? 'home' : h === a ? 'draw' : 'away';
      if (k === 'home') pH += p; else if (k === 'draw') pD += p; else pA += p;
      if (h + a > 2) over25 += p;
      if (h > 0 && a > 0) btts += p;
      if (p > bestBy[k].p) bestBy[k] = { p, h, a };
    }
  }
  const g = { pH: pH / total, pD: pD / total, pA: pA / total, over25: over25 / total, btts: btts / total };
  // Show the likeliest scoreline *within the likeliest outcome*, so the score never contradicts the 1/X/2 call.
  const lead = g.pH >= g.pD && g.pH >= g.pA ? 'home' : g.pA >= g.pD ? 'away' : 'draw';
  g.best = { ...bestBy[lead], p: bestBy[lead].p / total };
  return g;
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
    fx += p(`API-Football returned no scheduled fixture between ${H} and ${A} around ${esc(fmtDateOnly(d.date))}. This analysis therefore treats ${H} as the home side${r.venue.name ? ` at ${esc(r.venue.name)}` : ''} and assumes a ${r.sameLeague ? 'league' : r.compKind === 'cup' ? 'domestic cup' : 'continental or one-off'} setting. Kick-off time could not be confirmed.`);
  }
  if (home.coach || away.coach) {
    fx += p(`On the touchline, ${H} are managed by ${esc(home.coach || 'a manager the API could not identify')} and ${A} by ${esc(away.coach || 'a manager the API could not identify')}.`);
  }
  out.push(fx);

  // 2. Standings
  const stTxt = (s) => {
    if (!s.stand) return `${esc(s.team.name)}'s league position was not available.`;
    const st = s.stand, a = st.all;
    return `${esc(s.team.name)} are ${ordinal(st.rank)} in the ${esc(s.league ? s.league.name : 'league')} on ${st.points} points from ${a.played} games (${a.win}W ${a.draw}D ${a.lose}L, goal difference ${st.goalsDiff >= 0 ? '+' : ''}${st.goalsDiff})`;
  };
  let standing = h3(r.sameLeague ? 'League standings' : 'Standings in their own leagues');
  if (home.stand && away.stand && r.sameLeague) {
    const gap = Math.abs(home.stand.rank - away.stand.rank), pts = Math.abs(home.stand.points - away.stand.points);
    standing += p(`${stTxt(home)}, while ${stTxt(away)}. That is a gap of ${gap} place${gap === 1 ? '' : 's'} and ${pts} point${pts === 1 ? '' : 's'}.`);
  } else {
    standing += p(`${stTxt(home)}. ${stTxt(away)}.${!r.sameLeague && home.league && away.league ? ` These tables are not directly comparable, because ${esc(home.league.name)} and ${esc(away.league.name)} differ in strength.` : ''}`);
  }
  out.push(standing);

  // 3. Form
  let form = h3('Recent form');
  const fTxt = (s) => s.form.length
    ? `${esc(s.team.name)}: ${formLine(s.form)} (oldest to newest, last ${s.form.length}), scoring ${f1(s.formGF)} and conceding ${f1(s.formGA)} per game in all competitions.`
    : `${esc(s.team.name)}: no finished matches before this date were found for season ${d.season}.`;
  form += p(fTxt(home)) + p(fTxt(away));
  out.push(form);

  // 4. Goals & defence
  let gd = h3('Goalscoring and defensive patterns');
  const gdTxt = (s) => s.form.length
    ? `${esc(s.team.name)} kept ${s.cleanSheets} clean sheet${s.cleanSheets === 1 ? '' : 's'} and failed to score in ${s.failedToScore} of their last ${s.form.length}.${s.seasonGF != null ? ` Over the season they average ${f1(s.seasonGF)} scored and ${f1(s.seasonGA)} conceded.` : ''}`
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
    h2 += p(`In their last ${d.h2h.length} meetings, ${H} won ${hw}, ${A} won ${aw} and ${dr} ended level, with a combined goal tally of ${hg}-${ag} (${H} first). The latest meeting was ${esc(lp.comp)} on ${esc(new Date(lastF.fixture.timestamp * 1000).toISOString().slice(0, 10))}, a ${lp.gf}-${lp.ga} ${lp.res === 'W' ? 'win' : lp.res === 'L' ? 'loss' : 'draw'} for ${H}.`);
  } else {
    h2 += p(`The two clubs have no recorded meetings in API-Football's head-to-head data, so history plays no part in this prediction.`);
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
  inj += p(`${iTxt(home)} ${iTxt(away)} API-Football's injury feed often lags team news, so check the final line-ups.`);
  out.push(inj);

  // 7. Fixture-type specific
  if (r.sameLeague) {
    let ha = h3('Home advantage');
    const hs = home.homeSplit, as = away.awaySplit;
    if (hs && as) {
      ha += p(`${H} take ${f1(hs.ppg)} points per home league game (${hs.n} played), scoring ${f1(hs.gf)} and conceding ${f1(hs.ga)}. ${A} take ${f1(as.ppg)} per away league game (${as.n} played), scoring ${f1(as.gf)} and conceding ${f1(as.ga)}. ${hs.ppg - as.ppg > 0.4 ? 'The venue split favours the hosts clearly.' : hs.ppg - as.ppg < -0.4 ? 'The visitors travel unusually well, which cuts against the usual home edge.' : 'The venue split is modest, so home advantage matters less than usual.'}`);
    } else {
      ha += p(`There were too few home and away league results to split their records, so the model applies a standard home boost of about 10% to ${H}'s expected goals.`);
    }
    out.push(ha);
  }

  if (r.crossLeague) {
    const fav = home.strength * 1 >= away.strength ? home : away;
    const dog = fav === home ? away : home;
    const F = esc(fav.team.name), D = esc(dog.team.name);

    if (r.dims.includes('tier')) {
      let t = h3('Cross-tier dynamics: quality gap and mismatch');
      t += p(`The model's league-strength coefficients rate ${esc(home.league ? home.league.name : H)} at ${f1(home.strength)} and ${esc(away.league ? away.league.name : A)} at ${f1(away.strength)} on a 0 to 1 scale. ${r.strengthGap >= 0.12 ? `${F} come from the stronger division, which usually means a clear edge in squad depth and individual quality.` : 'The gap is small, so squad quality should be broadly comparable.'}`);
      t += p(`Rotation risk matters here. ${F} have played ${fav.load21} match${fav.load21 === 1 ? '' : 'es'} in the 21 days before this date, ${D} ${dog.load21}.${fav.load21 >= 6 ? ` That is a heavy load, so a rotated ${F} line-up is plausible and the model treats the favourite's edge with some caution.` : ' That is a manageable load, so a near-full-strength line-up is the safer assumption.'}`);
      t += p(`For the underdog, the numbers suggest ${dog.ga <= 1.1 ? `${D} are hard to break down and could sit in a low block, relying on set pieces and counters` : `${D} concede enough that a low block alone may not hold`}${dog.gf >= 1.5 ? `, and they carry real attacking threat` : `, but they create limited chances (${f1(dog.gf)} per game)`}. With little to lose, underdogs often play with freedom. ${fav.gf >= 1.8 ? `${F}'s scoring rate of ${f1(fav.gf)} per game suggests they can still dominate possession and territory.` : ''}`);
      out.push(t);
    }

    if (r.dims.includes('continental')) {
      let c = h3('Continental dynamics');
      const rnd = r.target && r.target.league.round ? r.target.league.round : null;
      c += p(`${r.comp ? `This is listed as a ${esc(r.comp.name)} fixture${rnd ? ` (${esc(rnd)})` : ''}.` : 'No official listing was found, so a continental setting is assumed from the clubs\' countries.'} Domestic form translates imperfectly, which is why the model rescales each side's goals by its league's strength before comparing them.`);
      c += p(`${home.team.country !== away.team.country ? `Travel from ${esc(away.team.country || 'abroad')} to ${esc(home.team.country || 'the host country')} adds fatigue and unfamiliar conditions for ${A}.` : 'Both clubs are from the same country, so travel is not a factor.'} ${rnd && /leg|round of|quarter|semi|play-?off/i.test(rnd) ? 'Knockout ties can be played over two legs, where aggregate scoring and away goals strategy shape how cautiously each side starts.' : 'Stakes depend on the stage of the tournament. Group or league-phase games reward risk less than knockout ties.'}`);
      out.push(c);
    }

    if (r.dims.includes('cup')) {
      let c = h3('Domestic cup dynamics');
      const rnd = r.target && r.target.league.round ? r.target.league.round : null;
      c += p(`${r.comp ? `The fixture is listed in the ${esc(r.comp.name)}${rnd ? `, ${esc(rnd)}` : ''}.` : 'No official listing was found, so a domestic cup tie is assumed because the clubs play in different divisions of the same country.'} If the score is level after 90 minutes, extra time and a penalty shootout may follow, depending on the competition and round. Some cups use replays or go straight to penalties in early rounds. Check the rules for this one.`);
      c += p(`Fixture congestion cuts both ways: ${F} played ${fav.load21} and ${D} played ${dog.load21} matches in the prior 21 days. Cup ties often see changes to the starting XI, which narrows the quality gap. The model does not predict extra time or penalties, so the score shown is a 90-minute scoreline.`);
      out.push(c);
    }

    if (r.dims.includes('normalized')) {
      let n = h3('Normalised statistics');
      const m = r.main;
      n += p(`To compare teams from different divisions, each side's goals scored are scaled up or down by its league-strength factor, and goals conceded are scaled the opposite way. The resulting expected goals (xG proxy) for this match are ${f1(m.lh)} for ${H} and ${f1(m.la)} for ${A}.`);
      n += `<div class="tablewrap"><table class="norm"><thead><tr><th>Team</th><th>Goals for</th><th>Goals against</th><th>Rating factor</th><th>Normalised attack</th><th>Normalised defence</th></tr></thead><tbody>
        <tr><td>${H}</td><td>${f1(home.gf)}</td><td>${f1(home.ga)}</td><td>${f1(home.f)}</td><td>${f1(m.atkH)}</td><td>${f1(m.concH)}</td></tr>
        <tr><td>${A}</td><td>${f1(away.gf)}</td><td>${f1(away.ga)}</td><td>${f1(away.f)}</td><td>${f1(m.atkA)}</td><td>${f1(m.concA)}</td></tr></tbody></table></div>`;
      n += p('Rating factors are heuristic estimates, not official coefficients. They are the weakest input in the model, so treat cross-league scorelines with extra caution.');
      out.push(n);
    }
  }

  // 8. Model view
  const g = r.grid;
  let mv = h3('How the prediction was reached');
  mv += p(`Blending season averages (60%) with the last ${CONFIG.FORM_WINDOW} matches (40%) gives expected goals of ${f1(r.main.lh)} for ${H} and ${f1(r.main.la)} for ${A}. A Poisson scoreline model gives ${pct(g.pH)} for ${H} to win, ${pct(g.pD)} for a draw and ${pct(g.pA)} for ${A} to win. The predicted score, ${g.best.h}-${g.best.a}, is the likeliest scoreline within the likeliest outcome.`);
  out.push(mv);

  return out.join('');
}

/* =========================================================
   Rendering
   ========================================================= */
function render(r) {
  const { home, away, grid: g, d } = r;
  const cmpLabel = r.target ? `${r.comp.name}${r.target.league.round ? ' · ' + r.target.league.round : ''}` : (r.sameLeague ? `${home.league.name} (assumed)` : 'Competition unconfirmed');
  const when = r.target ? fmtEAT(r.target.fixture.timestamp) : `${fmtDateOnly(d.date)} (kick-off time unconfirmed)`;
  const typeLabel = r.sameLeague && r.compKind === 'league' ? 'Same-league fixture' : 'Cross-league fixture';

  const lensRows = r.lenses.map((l) => {
    const w = leader(l.g);
    const txt = w === 'home' ? `${home.team.name} win` : w === 'away' ? `${away.team.name} win` : 'Draw';
    return `<li>${esc(l.name)}: ${esc(txt)} (${l.g.best.h}-${l.g.best.a})</li>`;
  }).join('');
  const leaders = r.lenses.map((l) => leader(l.g));
  const agree = leaders.every((x) => x === leaders[0]);
  const consensus = agree
    ? `All ${leaders.length} lens${leaders.length === 1 ? '' : 'es'} point to the same outcome: ${leaders[0] === 'draw' ? 'a draw' : (leaders[0] === 'home' ? home.team.name : away.team.name) + ' to win'}.`
    : 'The lenses disagree on the outcome, which is why confidence is held down.';

  const srcRows = d.sources.map((s) => `<li><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? 'OK' : 'Missing'}</span> ${esc(s.label)}: ${esc(s.detail)}</li>`).join('');
  const limits = [
    'Free plan: 10 requests per minute, 100 per day, and access limited to certain seasons.',
    'Injury data can lag real team news and is read from the most recent fixture record.',
    'League-strength factors are heuristic, so cross-league scorelines are the least reliable output.',
    'The model uses goals only. Lineups, tactics, weather, suspensions and betting markets are not included.',
    ...d.notes,
  ].map((x) => `<li>${esc(x)}</li>`).join('');

  $('#results').innerHTML = `
  <section class="block" aria-labelledby="s1">
    <h2 id="s1">Independent match prediction</h2>
    <div class="board">
      <div class="teams">
        <div class="team">${home.team.logo ? `<img class="crest" src="${esc(home.team.logo)}" alt="" onerror="this.remove()">` : ''}<b>${esc(home.team.name)}</b><span>Home</span></div>
        <div class="digits" aria-label="Predicted score ${g.best.h} to ${g.best.a}"><span class="cell">${g.best.h}</span><span class="sep">-</span><span class="cell">${g.best.a}</span></div>
        <div class="team away">${away.team.logo ? `<img class="crest" src="${esc(away.team.logo)}" alt="" onerror="this.remove()">` : ''}<b>${esc(away.team.name)}</b><span>Away</span></div>
      </div>
      <div class="meta">
        <div>${esc(typeLabel)}: ${esc(cmpLabel)}</div>
        <div>Venue: ${esc(r.venue.name || 'not listed')}${r.venue.city ? ', ' + esc(r.venue.city) : ''}</div>
        <div>Kick-off: ${esc(when)}</div>
      </div>
      <span class="conf ${r.level}">Confidence: ${r.level}</span>
      <div class="odds">
        <div class="strip" role="img" aria-label="Win probabilities"><i class="h" style="width:${g.pH * 100}%"></i><i class="d" style="width:${g.pD * 100}%"></i><i class="a" style="width:${g.pA * 100}%"></i></div>
        <div class="labels"><span>${esc(home.team.name)} ${pct(g.pH)}</span><span>Draw ${pct(g.pD)}</span><span>${esc(away.team.name)} ${pct(g.pA)}</span></div>
      </div>
      <div class="chips">
        <span>xG proxy ${f1(r.main.lh)} - ${f1(r.main.la)}</span>
        <span>Over 2.5 goals ${pct(g.over25)}</span>
        <span>Both teams score ${pct(g.btts)}</span>
        <span>Chance of exactly ${g.best.h}-${g.best.a}: ${pct(g.best.p)}</span>
      </div>
    </div>
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
      <div class="card wide"><h3>Model consensus view</h3>
        <ul>${lensRows}</ul>
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
    const data = await gather({ homeName, awayName, date, withCoaches: $('#coaches').checked });
    setStatus('Building prediction...');
    const result = analyze(data);
    render(result);
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
});
