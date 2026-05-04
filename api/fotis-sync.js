// api/fotis-sync.js
//
// Pushes "this player has at least one system card on file for this
// event" updates to Fotis's IIS endpoint (system_cards.asp).
//
// Each tournament's R2 config entry needs:
//   fotisBaseUrl: "https://db.eurobridge.org/path/to/console/"  (trailing slash)
//   groupName:    "European Mixed Teams 2026"  // exact EventGroupDescr
//
// Plus two Vercel env vars shared by all tournaments:
//   FOTIS_SC_TOKEN  shared secret matching utils.asp / SC_API_TOKEN
//
// If a tournament has no fotisBaseUrl OR no groupName configured,
// syncToFotis() is a no-op (so deployments without a Fotis console
// don't break).

const TOKEN = process.env.FOTIS_SC_TOKEN || '';

/**
 * @param {Object} args
 * @param {Object} args.tournament      Tournament record from R2 config
 * @param {string} args.subEvent        Sub-event name, e.g. "Open Teams"
 * @param {"upsert"|"remove"} args.action
 * @param {Array<{contactinfoid:number, fullName?:string}>} args.players
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, applied?:any[]}>}
 */
export async function syncToFotis({ tournament, subEvent, action, players }) {
  if (!tournament || !tournament.fotisBaseUrl || !tournament.groupName) {
    return { ok: true, skipped: 'No Fotis console configured for this tournament' };
  }
  if (!TOKEN) {
    return { ok: false, error: 'FOTIS_SC_TOKEN env var not set' };
  }
  if (!subEvent) {
    return { ok: false, error: 'Missing subEvent' };
  }
  if (!players || !players.length) {
    return { ok: true, applied: [] };
  }

  // Filter to players with a usable contactinfoid (numeric, > 0)
  const cleaned = players
    .map(p => ({
      contactinfoid: parseInt(p.contactinfoid, 10),
      fullName: p.fullName || null,
    }))
    .filter(p => Number.isFinite(p.contactinfoid) && p.contactinfoid > 0);

  if (!cleaned.length) {
    return { ok: true, applied: [], skipped: 'No valid contactinfoids' };
  }

  const url = tournament.fotisBaseUrl.replace(/\/+$/, '') + '/system_cards.asp';
  const body = JSON.stringify({
    tournamentName: tournament.groupName,
    subEvent,
    action,
    players: cleaned,
  });

  // 8s timeout; Fotis console runs on a beefy server but we don't want
  // a stuck call to delay the upload response visibly.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SC-Token': TOKEN,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `Fotis ${r.status}: ${text.slice(0, 200)}` };
    }
    const json = await r.json().catch(() => ({}));
    return { ok: true, ...json };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: String(err && err.message || err) };
  }
}
