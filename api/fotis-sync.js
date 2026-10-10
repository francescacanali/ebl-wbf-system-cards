// api/fotis-sync.js
//
// Pushes "this player has at least one system card on file for this
// event" updates to Fotis's IIS endpoint (system_cards.asp), together
// with the card's review status (statusint 0/1/2, see below).
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

// ─────────────────────────────────────────────────────────────────
// statusint convention in Fotis's tblPlayerEventSC
//   0 = pending  (uploaded, not yet reviewed)
//   1 = accepted (the admin UI writes 'validated'; older code 'accepted')
//   2 = refused  (row is KEPT so the portal can show "refused")
//   no row = no card (only admin-delete sends "remove")
// ─────────────────────────────────────────────────────────────────
export const STATUSINT_PENDING  = 0;
export const STATUSINT_ACCEPTED = 1;
export const STATUSINT_REFUSED  = 2;

/**
 * Turn a card status into the plain status text stored in D1.
 * The admin page sends a refusal as an OBJECT
 * ({status:'refused', reason:'...'}) and an acceptance as the
 * string 'validated'; this accepts both shapes.
 *
 * Variables:
 *   rawStatus       - the status as received (string or object)
 *   statusText      - the plain, lower-case status text we return
 */
export function normalizeStatusText(rawStatus) {
  let statusText = rawStatus;
  if (rawStatus && typeof rawStatus === 'object') {
    statusText = rawStatus.status;
  }
  return String(statusText || '').trim().toLowerCase();
}

/**
 * Map a card status (string or admin-page object) to Fotis statusint.
 *
 * Variables:
 *   rawStatus       - the status as received (string or object)
 *   statusText      - the normalized status text
 */
export function statusToStatusInt(rawStatus) {
  const statusText = normalizeStatusText(rawStatus);
  if (statusText === 'accepted' || statusText === 'validated') {
    return STATUSINT_ACCEPTED;
  }
  if (statusText === 'refused') {
    return STATUSINT_REFUSED;
  }
  return STATUSINT_PENDING;
}

/**
 * @param {Object} args
 * @param {Object} args.tournament      Tournament record from R2 config
 * @param {string} args.subEvent        Sub-event name, e.g. "Open Teams"
 * @param {"upsert"|"remove"} args.action
 * @param {Array<{
 *   contactinfoid: number,
 *   fullName?: string,
 *   statusint?: number,   // 0=pending (default), 1=accepted, 2=refused
 *   pdflink?: string      // R2 public URL of the PDF (optional)
 * }>} args.players
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

  // Strip the EBL/WBF event-code prefix ("#26135 ") that the SC
  // platform's UI uses but Fotis's tblTournaments.TournName doesn't.
  // E.g. "#26135 U16 Teams" -> "U16 Teams"
  const cleanSubEvent = String(subEvent).replace(/^#\d+\s*/, '').trim();

  // Filter to players with a usable contactinfoid (numeric, > 0).
  // Forward statusint and pdflink so Fotis can populate tblPlayerEventSC.
  const cleaned = players
    .map(p => {
      const out = {
        contactinfoid: parseInt(p.contactinfoid, 10),
        fullName: p.fullName || null,
      };
      // Only include optional fields if present, so we don't change wire
      // format for callers that don't care about them.
      // Only 0, 1 and 2 are valid; anything else is sent as 0 (pending).
      // (Previously this forced everything except 1 to 0, which would
      // have silently turned "refused" (2) into "pending".)
      if (p.statusint !== undefined && p.statusint !== null) {
        const requestedStatusInt = Number(p.statusint);
        const isValidStatusInt =
          requestedStatusInt === STATUSINT_PENDING  ||
          requestedStatusInt === STATUSINT_ACCEPTED ||
          requestedStatusInt === STATUSINT_REFUSED;
        out.statusint = isValidStatusInt ? requestedStatusInt : STATUSINT_PENDING;
      }
      if (p.pdflink) {
        out.pdflink = String(p.pdflink);
      }
      return out;
    })
    .filter(p => Number.isFinite(p.contactinfoid) && p.contactinfoid > 0);

  if (!cleaned.length) {
    return { ok: true, applied: [], skipped: 'No valid contactinfoids' };
  }

  const url = tournament.fotisBaseUrl.replace(/\/+$/, '') + '/system_cards.asp';
  const body = JSON.stringify({
    tournamentName: tournament.groupName,
    subEvent: cleanSubEvent,
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
