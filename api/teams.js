export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tournamentCode = req.query.tournament || '26prague';
  const aspUrl = `https://db.eurobridge.org/repository/competitions/${tournamentCode}/Reg/displayteamsparticipanalytical.asp`;
  
  try {
    const response = await fetch(aspUrl);
    const html = await response.text();
    
    const teams = parseTeamsHtml(html);
    
    return res.status(200).json({ teams });
    
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({ error: 'Failed to fetch teams: ' + error.message });
  }
}

function parseTeamsHtml(html) {
  const teams = [];
  
  // Extract table rows using regex
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;
    
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }
    
    if (cells.length >= 4) {
      const event = cells[0];
      const teamId = cells[1];
      const teamName = cells[2];
      const roster = cells[3];
      
      // Skip header rows or empty rows
      if (!teamName || teamName === 'Team Name' || !teamId || isNaN(parseInt(teamId))) continue;
      
      const players = parseRoster(roster);
      
      if (players.length >= 2) {
        teams.push({
          id: teamId,
          event,
          name: teamName,
          players,
          uploadedCards: [] // Will be populated later
        });
      }
    }
  }
  
  return teams;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .trim();
}

function parseRoster(rosterText) {
  const players = [];
  // Pattern: "Nome COGNOME (12345)" with possible roles like "captain" or "coach"
  const regex = /([A-Za-zÀ-ÿ\s\-'\.]+)\s*\((\d+)\)/g;
  let match;
  const seen = new Set();
  
  while ((match = regex.exec(rosterText)) !== null) {
    const fullName = match[1].trim();
    const wbfId = match[2];
    
    // Avoid duplicates (some players may appear twice with different roles)
    if (!seen.has(wbfId)) {
      seen.add(wbfId);
      
      // Extract surname (last uppercase word) and first name
      const parts = fullName.split(/\s+/);
      const surnameIndex = parts.findIndex(p => p === p.toUpperCase() && p.length > 1);
      
      let surname;
      if (surnameIndex >= 0) {
        surname = parts[surnameIndex];
      } else {
        surname = parts[parts.length - 1];
      }
      
      players.push({
        fullName,
        surname: surname.toUpperCase(),
        wbfId
      });
    }
  }
  
  return players;
}
