# Operation Muhindi arudi India Football Match Predictor

Single-page web app (plain HTML, CSS and JavaScript, no build step) that predicts a score and writes a rationale for same-league and cross-league fixtures, using live data from API-Football.

## Run it
1. Keep `index.html`, `styles.css` and `app.js` in one folder.
2. Open `index.html` in a modern browser (needs internet for the API).
3. Enter home team, away team and match date, then press **Run Deep Analysis**.

## Output
1. **Independent match prediction**: scoreboard, venue, kick-off in EAT, confidence, 1/X/2 probabilities.
2. **Prediction rationale**: fixture, standings, form, goals, head-to-head, injuries, plus home advantage (same league) or cross-tier / continental / cup / normalised-stats sections (cross-league).
3. **Consensus and metadata**: data sources, coverage, three-lens consensus, limitations.

## Data-integrity rules
- No guessed values: league averages, draw rates, venue rates and opponent strength are all measured from API-Football tables and fixtures.
- Missing data means abstaining or saying so on screen, never an assumed average. If a team's league table or baseline is missing, the app shows "No prediction: insufficient verified data" with the reasons.
- Early in a season the league baseline is pooled with the previous season's table (both from the API) and the app says so.
- No cross-league strength scale is used because no verified free source exists. Cross-league ties are rated within each team's own league and lean on bookmaker odds when available.
- Modelling settings (form half-life, shrinkage, blend weights) are listed on screen as choices, not facts.

## Model inputs
Venue-split goal rates, opponent-adjusted recency-weighted form, league draw-rate calibration, optional bookmaker odds blend (margin removed), API-Football forecast as a consensus lens. Rest days and stakes are reported but not applied.

## Prediction log
Predictions for confirmed fixtures are saved in the browser. "Check finished matches" fetches final scores and reports accuracy and Brier score so the settings can be tuned on real results.

## Free-plan handling
- No `last=` parameter anywhere; form (6) and head-to-head (10) are sliced locally.
- Season is derived from the match date; if the plan blocks it, the app falls back to the newest allowed season and says so.
- Built-in limiter keeps to 9 requests per minute. One run uses about 8-14 requests (100 per day on the free plan).

## Security note
The API key is in `app.js` and is visible to anyone who opens the page. Move calls behind a small server and rotate the key before sharing publicly.

Predictions are statistical estimates, not betting advice.
