// api/db.js — Cloudflare D1 helper for system cards platform

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const CF_D1_SC_ID   = process.env.CF_D1_SC_DATABASE_ID; // separate D1 for system cards

export async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_SC_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json.result[0];
}

// Save a card and its players, return card id
export async function saveCard({ tournament, sub_event, event_folder, file_name, file_url, player_ids, player_names }) {
  // Insert card
  const result = await d1(
    `INSERT INTO system_cards (tournament, sub_event, event_folder, file_name, file_url, status, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
     RETURNING id`,
    [tournament, sub_event || null, event_folder || null, file_name, file_url]
  );
  const cardId = result.results[0].id;

  // Insert players
  for (let i = 0; i < player_ids.length; i++) {
    await d1(
      `INSERT INTO system_card_players (card_id, player_id, player_name) VALUES (?, ?, ?)`,
      [cardId, player_ids[i], player_names[i] || null]
    );
  }

  return cardId;
}

// Update card status (accepted / refused)
export async function updateCardStatus({ card_id, status, refused_reason, validated_by }) {
  await d1(
    `UPDATE system_cards SET status=?, refused_reason=?, validated_by=?, validated_at=datetime('now') WHERE id=?`,
    [status, refused_reason || null, validated_by || null, card_id]
  );
}

// Get all cards for a tournament (with players)
export async function getCardsForTournament(tournament) {
  const cards = await d1(
    `SELECT * FROM system_cards WHERE tournament=? ORDER BY uploaded_at DESC`,
    [tournament]
  );

  const result = [];
  for (const card of (cards.results || [])) {
    const players = await d1(
      `SELECT player_id, player_name FROM system_card_players WHERE card_id=? ORDER BY id`,
      [card.id]
    );
    result.push({
      ...card,
      players: players.results || []
    });
  }
  return result;
}

// Get cards for a specific player in a tournament
export async function getCardsForPlayer(tournament, player_id) {
  const result = await d1(
    `SELECT sc.* FROM system_cards sc
     INNER JOIN system_card_players scp ON scp.card_id = sc.id
     WHERE sc.tournament=? AND scp.player_id=?
     ORDER BY sc.uploaded_at DESC`,
    [tournament, player_id]
  );
  return result.results || [];
}

// Check if every player in a list has at least one accepted card
export async function getPlayerSCStatus(tournament, player_ids) {
  const status = {};
  for (const pid of player_ids) {
    const res = await d1(
      `SELECT COUNT(*) as cnt FROM system_cards sc
       INNER JOIN system_card_players scp ON scp.card_id=sc.id
       WHERE sc.tournament=? AND sc.status='accepted' AND scp.player_id=?`,
      [tournament, pid]
    );
    status[pid] = (res.results[0]?.cnt || 0) > 0;
  }
  return status;
}

// Get the players (id + name) attached to a single card by tournament+filename
export async function getCardPlayersByFileName(tournament, file_name) {
  const cardRow = await d1(
    `SELECT id, sub_event FROM system_cards
      WHERE tournament=? AND file_name=? LIMIT 1`,
    [tournament, file_name]
  );
  const card = (cardRow.results || [])[0];
  if (!card) return { card: null, players: [] };

  const players = await d1(
    `SELECT player_id, player_name FROM system_card_players WHERE card_id=?`,
    [card.id]
  );
  return { card, players: players.results || [] };
}

// For a given (tournament, sub_event, player), is there any OTHER card
// (i.e. excluding the supplied file_name) that hasn't been hidden? We
// don't have a "hidden" column in D1 yet — hiding lives in R2's
// hidden.json — so the caller needs to filter the hidden list itself.
// This helper just returns the file_names of all cards for that player
// in that sub_event.
export async function getOtherCardFileNamesForPlayer(tournament, sub_event, player_id, exclude_file_name) {
  const rows = await d1(
    `SELECT sc.file_name
       FROM system_cards sc
       JOIN system_card_players scp ON scp.card_id = sc.id
      WHERE sc.tournament = ?
        AND sc.sub_event  = ?
        AND scp.player_id = ?
        AND sc.file_name <> ?`,
    [tournament, sub_event, player_id, exclude_file_name]
  );
  return (rows.results || []).map(r => r.file_name);
}
