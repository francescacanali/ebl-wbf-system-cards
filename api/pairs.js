export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tournamentCode = req.query.tournament || '26prague';
  const aspUrl = `https://db.eurobridge.org/repository/competitions/${tournamentCode}/Reg/displaypairsparticip.asp`;
  
  try {
    const response = await fetch(aspUrl);
    const html = await response.text();
    
    let pairs = parsePairsHtml(html);
    
    // Sort pairs alphabetically by first player's surname
    pairs.sort((a, b) => {
      const surnameA = a.players[0]?.surname || '';
      const surnameB = b.players[0]?.surname || '';
      return surnameA.localeCompare(surnameB);
    });
    
    return res.status(200).json({ pairs });
    
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({ error: 'Failed to fetch pairs: ' + error.message });
  }
}

function parsePairsHtml(html) {
  const pairs = [];
  
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
    
    // Pairs table: Event, ID, Pair, Country, Submitted by, Email, Code
    if (cells.length >= 4) {
      const event = cells[0];
      const pairId = cells[1];
      const pairNames = cells[2];
      const country = cells[3];
      
      // Skip header rows
      if (!pairId || pairId === 'ID' || !pairNames || pairNames === 'Pair') continue;
      
      // Parse pair names: "Nome1 COGNOME1-Nome2 COGNOME2"
      let players = parsePairNames(pairNames);
      
      if (players.length === 2) {
        // Sort players within pair alphabetically by surname
        players.sort((a, b) => a.surname.localeCompare(b.surname));
        
        // Map short event names to full names
        const fullEventName = mapEventName(event);
        
        // Create display name with sorted players
        const displayName = players.map(p => p.fullName).join(' - ');
        
        pairs.push({
          id: pairId,
          event: fullEventName,
          eventShort: event,
          name: displayName,
          country,
          players
        });
      }
    }
  }
  
  return pairs;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\[email[^\]]*\]/g, '') // Remove email placeholders
    .trim();
}

function parsePairNames(pairString) {
  // Format: "Nome1 COGNOME1-Nome2 COGNOME2"
  const players = [];
  const parts = pairString.split('-');
  
  for (const part of parts) {
    const fullName = part.trim();
    if (!fullName) continue;
    
    // Extract surname (last uppercase word or last word)
    const words = fullName.split(/\s+/);
    const surnameIndex = words.findIndex(w => w === w.toUpperCase() && w.length > 1);
    
    let surname;
    if (surnameIndex >= 0) {
      surname = words[surnameIndex];
    } else {
      surname = words[words.length - 1];
    }
    
    players.push({
      fullName,
      surname: surname.toUpperCase(),
      wbfId: '' // Pairs table doesn't have WBF IDs
    });
  }
  
  return players;
}

function mapEventName(shortName) {
  const mapping = {
    'Winter Open Pairs': 'EUROPEAN WINTER OPEN PAIRS',
    'Winter Mixed Pairs': 'EUROPEAN WINTER MIXED PAIRS',
  };
  
  return mapping[shortName] || shortName;
}
