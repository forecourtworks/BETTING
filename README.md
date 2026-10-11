# Grok Football Match Predictor

Single-page web app (plain HTML, CSS and JavaScript, no build step) that predicts a score and writes a rationale for same-league and cross-league fixtures, using live data from API-Football.

## Run it
1. Keep `index.html`, `styles.css` and `app.js` in one folder.
2. Open `index.html` in a modern browser (needs internet for the API).
3. Enter home team, away team and match date, then press **Run Deep Analysis**.

## Output
1. **Independent match prediction**: scoreboard, venue, kick-off in EAT, confidence, 1/X/2 probabilities.
2. **Prediction rationale**: fixture, standings, form, goals, head-to-head, injuries, plus home advantage (same league) or cross-tier / continental / cup / normalised-stats sections (cross-league).
3. **Consensus and metadata**: data sources, coverage, three-lens consensus, limitations.

## Free-plan handling
- No `last=` parameter anywhere; form (6) and head-to-head (10) are sliced locally.
- Season is derived from the match date; if the plan blocks it, the app falls back to the newest allowed season and says so.
- Built-in limiter keeps to 9 requests per minute. One run uses about 8-12 requests (100 per day on the free plan).

## Security note
The API key is in `app.js` and is visible to anyone who opens the page. Move calls behind a small server and rotate the key before sharing publicly.

Predictions are statistical estimates, not betting advice.
