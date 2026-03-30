// api/team-cards.js
// GET /api/team-cards?tournament=26riga&player_ids=123,456,789
// Returns all cards for the given player IDs with status
// Used by Fotis's team portal to display system card status

import { getCardsForTournament, getPlayerSCStatus } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { tournament, player_ids } = req.query;

  if (!tournament || !player_ids) {
    return res.status(400).json({ error: 'Missing tournament or player_ids' });
  }

  const playerIdList = player_ids.split(',').map(id => parseInt(id.trim())).filter(Boolean);
  if (!playerIdList.length) {
    return res.status(400).json({ error: 'No valid player IDs' });
  }

  try {
    // Get all cards for this tournament
    const allCards = await getCardsForTournament(tournament);

    // Filter to only cards that include at least one of the requested players
    const teamCards = allCards.filter(card =>
      card.players.some(p => playerIdList.includes(p.player_id))
    );

    // Per-player status: has at least one accepted card?
    const playerStatus = await getPlayerSCStatus(tournament, playerIdList);

    return res.status(200).json({
      tournament,
      cards: teamCards.map(c => ({
        id:            c.id,
        file_name:     c.file_name,
        file_url:      c.file_url,
        sub_event:     c.sub_event,
        status:        c.status,        // 'pending' | 'accepted' | 'refused'
        refused_reason: c.refused_reason,
        uploaded_at:   c.uploaded_at,
        players:       c.players,       // [{player_id, player_name}, ...]
      })),
      player_status: playerStatus,      // {player_id: true/false, ...}
    });

  } catch (err) {
    console.error('team-cards error:', err);
    return res.status(500).json({ error: err.message });
  }
}
