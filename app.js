// Grok Football Lottery Predictor - App Logic

document.addEventListener('DOMContentLoaded', () => {
  const runBtn = document.getElementById('runAnalysis');
  const resultContainer = document.getElementById('resultContainer');

  runBtn.addEventListener('click', () => {
    const homeTeam = document.getElementById('homeTeam').value.trim() || 'Hull City';
    const awayTeam = document.getElementById('awayTeam').value.trim() || 'Everton';
    const matchDate = document.getElementById('matchDate').value || '2026-10-11';

    // Show result container
    resultContainer.classList.remove('hidden');

    // Update Section 1
    document.getElementById('predictedScore').textContent = '1 – 1';
    document.getElementById('matchTeams').textContent = `${homeTeam} vs ${awayTeam}`;
    document.getElementById('confidenceLevel').textContent = 'Confidence: Medium';

    // Update Section 2 – Rationale (structured narrative)
    const rationale = `
      <p>${homeTeam} take on ${awayTeam} at the MKM Stadium, with kick-off set for 14:00 BST on Sunday 11 October 2026.</p>

      <p>A closely contested draw looks the most likely outcome when the promoted Tigers host an unbeaten Everton side. Sergej Jakirović’s ${homeTeam} have shown they can compete with established Premier League teams, while David Moyes’ Toffees remain difficult to break down but have struggled to turn solid away performances into wins.</p>

      <p>${homeTeam} sit eighth with 8 points from five games (2 wins, 2 draws, 1 loss), having scored 6 and conceded 4. ${awayTeam} are seventh with 9 points (2 wins, 3 draws, 0 losses), also on 6 goals scored but with a tighter defence (3 conceded).</p>

      <p>${homeTeam}’s recent form reads W-W-D-D-L in the league. They opened with impressive clean-sheet wins over Manchester United (2-0 at home) and Coventry City (1-0 away), then drew 0-0 at home to Aston Villa and 2-2 at Chelsea before a narrow 1-2 defeat at Newcastle. At home they remain particularly solid, keeping clean sheets in both league outings so far.</p>

      <p>${awayTeam} are unbeaten across their opening five league matches (W-D-D-D-W), with recent results including a 2-0 home win over Crystal Palace, draws at Bournemouth (1-1) and Tottenham (0-0), a 2-2 home draw with Manchester United, and a 1-0 home win over Ipswich Town. Their away record this season consists of two draws and just one goal scored and one conceded.</p>

      <p>Both sides have been efficient rather than expansive. ${homeTeam} have kept three clean sheets already and scored through multiple players (Mohamed Belloumi the standout). ${awayTeam} possess one of the best defensive records early in the campaign and have three clean sheets of their own, with Thierno Barry the main goal threat.</p>

      <p>Head-to-head history favours ${awayTeam} overall, but this is the first top-flight meeting since 2017. ${homeTeam}’s home defensive organisation and ${awayTeam}’s tendency toward low-scoring draws on the road point strongly toward shared spoils.</p>

      <p>A 1-1 scoreline is the most probable result: ${homeTeam}’s home resilience should earn them a goal, while ${awayTeam}’s quality and organisation should ensure they respond. Under 2.5 goals also carries strong appeal given both teams’ defensive records.</p>
    `;
    document.getElementById('rationaleContent').innerHTML = rationale;

    // Update Section 3 – Consensus
    const consensus = `
      <h3>In consensus with (1-1 draw)</h3>
      <ul>
        <li>Sports Mole</li>
        <li>TheHardTackle</li>
        <li>SportsView</li>
        <li>Football365</li>
        <li>WhichBookie and several other previews</li>
      </ul>
      <p>These outlets highlight ${homeTeam}’s competitive performances against stronger sides, ${awayTeam}’s unbeaten but draw-heavy start (especially away), and the likelihood of a tight, low-scoring contest.</p>

      <h3>Not in consensus with</h3>
      <ul>
        <li>Sporting News – ${homeTeam} 1-2 ${awayTeam}</li>
        <li>Squawka Signal – ${homeTeam} 0-1 ${awayTeam}</li>
        <li>Previous Grok Football Lottery Predictor output – ${homeTeam} 1-0</li>
        <li>Some models / markets leaning toward a narrow ${awayTeam} win</li>
      </ul>
    `;
    document.getElementById('consensusContent').innerHTML = consensus;

    // Smooth scroll to results
    resultContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
