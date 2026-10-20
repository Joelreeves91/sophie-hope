// ── Strava Webhook Handler ──────────────────────────────────
// Netlify Function: netlify/functions/strava-webhook.js
//
// Handles two request types from Strava:
//   GET  — Strava subscription verification challenge
//   POST — New activity event (run completed)
//
// On a new run, it:
//   1. Refreshes the Strava access token
//   2. Fetches the activity details (date, type, distance)
//   3. Writes the activity date to Firebase so the plan auto-ticks
//
// Environment variables required in Netlify dashboard:
//   STRAVA_CLIENT_ID       — from strava.com/settings/api
//   STRAVA_CLIENT_SECRET   — from strava.com/settings/api
//   STRAVA_REFRESH_TOKEN   — long-lived token from OAuth flow
//   STRAVA_VERIFY_TOKEN    — any string you choose (used once at setup)
//   FIREBASE_PROJECT_ID    — runner-plan-host
//   FIREBASE_API_KEY       — AIzaSyC5QoBcLCQR-YwDzLL9FSuHtYd2LbzSHDQ
//   PLAN_ID                — joel-abingdon-2026

// ── Strava: refresh access token ─────────────────────────────
async function refreshStravaToken() {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Strava: fetch activity details ───────────────────────────
async function fetchActivity(activityId, accessToken) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava API ${res.status}`);
  return res.json();
}

// ── Firebase: remember which Strava activity ID belongs to which date ─
// This is the only genuinely new thing. Everything else in this file
// is unchanged. It writes to a separate field, strava_activity_ids,
// shaped like: { "2026-08-15": "16019283746", "2026-08-13": "16011..." }
async function markActivityIdInFirebase(date, activityId) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_API_KEY;
  const planId    = process.env.PLAN_ID;
  const docUrl    = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/plans/${planId}?key=${apiKey}`;

  // IMPORTANT: we do NOT use a field mask like `strava_activity_ids.2026-08-17`.
  // Firestore treats the dots in a date as nested-path separators, so that mask
  // means "field 2026 → subfield 08-17", which silently fails to store anything.
  // Instead: read the existing map, add this date, and write the WHOLE
  // strava_activity_ids field back under a single clean mask. This is the same
  // approach the backfill uses, which is why backfilled dates worked and
  // webhook-written ones did not.
  let existing = {};
  const readRes = await fetch(docUrl);
  if (readRes.ok) {
    const doc = await readRes.json();
    const raw = doc.fields && doc.fields.strava_activity_ids;
    if (raw && raw.mapValue && raw.mapValue.fields) existing = raw.mapValue.fields;
  }

  // Already stored for this date? Nothing to do.
  if (existing[date] && existing[date].stringValue === String(activityId)) {
    console.log(`[Strava] Activity ${activityId} already stored for ${date}.`);
    return;
  }

  existing[date] = { stringValue: String(activityId) };

  const patchUrl = `${docUrl}&updateMask.fieldPaths=strava_activity_ids`;
  const patchRes = await fetch(patchUrl, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: { strava_activity_ids: { mapValue: { fields: existing } } },
    }),
  });

  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Firebase activity-ID PATCH failed: ${err}`);
  }
  console.log(`[Strava] Stored activity ${activityId} for ${date}.`);
}

// ── Firebase: add date to strava_completed_dates array ───────
async function markDateInFirebase(date) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_API_KEY;
  const planId    = process.env.PLAN_ID;
  const docUrl    = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/plans/${planId}?key=${apiKey}`;

  // Read current document
  const readRes = await fetch(docUrl);
  let existingDates = [];

  if (readRes.ok) {
    const doc = await readRes.json();
    if (doc.fields && doc.fields.strava_completed_dates) {
      existingDates = (doc.fields.strava_completed_dates.arrayValue.values || [])
        .map(v => v.stringValue)
        .filter(Boolean);
    }
  }

  // Add new date if not already present
  if (existingDates.includes(date)) {
    console.log(`[Strava] Date ${date} already marked.`);
    return;
  }
  existingDates.push(date);

  // Write back — PATCH only the strava_completed_dates field
  const patchUrl = `${docUrl}&updateMask.fieldPaths=strava_completed_dates`;
  const patchRes = await fetch(patchUrl, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        strava_completed_dates: {
          arrayValue: {
            values: existingDates.map(d => ({ stringValue: d })),
          },
        },
      },
    }),
  });

  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Firebase PATCH failed: ${err}`);
  }

  console.log(`[Strava] Marked ${date} as complete in Firebase.`);
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {

  // ── GET: Strava webhook subscription verification ─────────
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    if (p['hub.verify_token'] !== process.env.STRAVA_VERIFY_TOKEN) {
      return { statusCode: 403, body: 'Invalid verify token' };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'hub.challenge': p['hub.challenge'] }),
    };
  }

  // ── POST: Activity event ──────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: 'Bad JSON' };
    }

    // Only process newly created activities
    if (body.aspect_type !== 'create' || body.object_type !== 'activity') {
      return { statusCode: 200, body: 'Ignored' };
    }

    try {
      // 1. Get fresh access token
      const accessToken = await refreshStravaToken();

      // 2. Fetch activity details
      const activity = await fetchActivity(body.object_id, accessToken);

      // 3. Only process runs
      const type = activity.sport_type || activity.type || '';
      if (!['Run', 'TrailRun', 'VirtualRun'].includes(type)) {
        return { statusCode: 200, body: `Skipped: ${type}` };
      }

      // 4. Extract local activity date (YYYY-MM-DD)
      const date = (activity.start_date_local || '').split('T')[0];
      if (!date) {
        return { statusCode: 400, body: 'No activity date found' };
      }

      const distKm = Math.round((activity.distance || 0) / 100) / 10;
      console.log(`[Strava] Run on ${date} · ${distKm}km — marking in Firebase`);

      // 5. Write to Firebase
      await markDateInFirebase(date);
      await markActivityIdInFirebase(date, body.object_id);   // <-- the only new line that matters

      return { statusCode: 200, body: `OK — ${date} marked` };

    } catch (err) {
      console.error('[Strava] Webhook error:', err);
      // Return 200 to prevent Strava from retrying endlessly
      return { statusCode: 200, body: `Error handled: ${err.message}` };
    }
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
