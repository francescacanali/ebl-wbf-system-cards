// api/team-cards.js
//
// Three query modes:
//
// 1) All cards for a tournament:
//    GET /api/team-cards?tournament=26riga
//
// 2) All cards for a specific sub-event:
//    GET /api/team-cards?tournament=26riga&sub_event=Open+Teams
//
// 3) A specific card by ID:
//    GET /api/team-cards?card_id=42
//
// Optional filters (modes 1 and 2):
//    &player_ids=30303,17813   → only cards involving these players
//    &status=accepted          → only cards with this status (pending/accepted/refused)

import { d1, getPlayerSCStatus } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { tournament, sub_event, card_id, player_ids, status } = req.query;

  try {

    // ── Mode 3: specific card by ID ──────────────────────────────────────
    if (card_id) {
      const cardRes = await d1(
        `SELECT * FROM system_cards WHERE id=?`, [parseInt(card_id)]
      );
      const card = cardRes.results?.[0];
      if (!card) return res.status(404).json({ error: 'Card not found' });

      const playersRes = await d1(
        `SELECT player_id, player_name FROM system_card_players WHERE card_id=? ORDER BY id`,
        [card.id]
      );
      return res.status(200).json({
        card: { ...card, players: playersRes.results || [] }
      });
    }

    // ── Modes 1 & 2: by tournament (+ optional sub_event) ────────────────
    if (!tournament) {
      return res.status(400).json({
        error: 'Provide either card_id or tournament',
        usage: [
          'GET /api/team-cards?tournament=26riga',
          'GET /api/team-cards?tournament=26riga&sub_event=Open+Teams',
          'GET /api/team-cards?card_id=42',
        ]
      });
    }

    // Build query
    let sql    = `SELECT * FROM system_cards WHERE tournament=?`;
    let params = [tournament];

    if (sub_event) {
      sql += ` AND sub_event=?`;
      params.push(sub_event);
    }
    if (status) {
      sql += ` AND status=?`;
      params.push(status);
    }
    sql += ` ORDER BY uploaded_at DESC`;

    const cardsRes = await d1(sql, params);
    let cards = cardsRes.results || [];

    // Attach players to each card
    const cardsWithPlayers = await Promise.all(cards.map(async card => {
      const pRes = await d1(
        `SELECT player_id, player_name FROM system_card_players WHERE card_id=? ORDER BY id`,
        [card.id]
      );
      return { ...card, players: pRes.results || [] };
    }));

    // Optional player_ids filter
    let filtered = cardsWithPlayers;
    let playerStatus = {};

    if (player_ids) {
      const playerIdList = player_ids.split(',').map(id => parseInt(id.trim())).filter(Boolean);
      filtered = cardsWithPlayers.filter(card =>
        card.players.some(p => playerIdList.includes(p.player_id))
      );
      playerStatus = await getPlayerSCStatus(tournament, playerIdList);
    }

    return res.status(200).json({
      tournament,
      sub_event:  sub_event || null,
      total:      filtered.length,
      cards:      filtered.map(c => ({
        id:             c.id,
        file_name:      c.file_name,
        file_url:       c.file_url,
        sub_event:      c.sub_event,
        status:         c.status,
        refused_reason: c.refused_reason,
        uploaded_at:    c.uploaded_at,
        players:        c.players,
      })),
      ...(player_ids ? { player_status: playerStatus } : {}),
    });

  } catch (err) {
    console.error('team-cards error:', err);
    return res.status(500).json({ error: err.message });
  }
}
