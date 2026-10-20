// ── One-Time Backfill: fill in strava_activity_ids for past runs ────
// Netlify Function: netlify/functions/backfill-activity-ids.js
//
// The webhook only fires on NEW activities from now on. It has no way
// to know about runs you completed before this feature existed, those
// are already marked "done" via strava_completed_dates, but have no
// activity ID attached, so tapping them won't show a map.
//
// This function fixes that, once. Visit its URL in a browser (or curl
// it) one time after deploying, then you can forget it exists.
//
// Same environment variables as the other two functions.

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

exports.handler = async () => {
  try {
    const accessToken = await refreshStravaToken();

    // Strava's activity list, paginated, most recent first.
    // 200 per page is the max; loops until it runs out or hits ~2 years back.
    let allActivities = [];
    let page = 1;
    while (page <= 10) { // 10 pages * 200 = up to 2000 activities, plenty
      const res = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) throw new Error(`Strava activities ${res.status}`);
      const batch = await res.json();
      if (batch.length === 0) break;
      allActivities = allActivities.concat(batch);
      page++;
    }

    // Build { date: activityId } for runs only
    const dateToId = {};
    allActivities.forEach(a => {
      const type = a.sport_type || a.type || '';
      if (!['Run', 'TrailRun', 'VirtualRun'].includes(type)) return;
      const date = (a.start_date_local || '').split('T')[0];
      if (!date) return;
      // if a date somehow has two runs, keep the first one Strava returns (most recent run wins, since list is newest-first)
      if (!dateToId[date]) dateToId[date] = a.id;
    });

    // Write the whole map into Firebase in one go
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey    = process.env.FIREBASE_API_KEY;
    const planId    = process.env.PLAN_ID;
    const docUrl    = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/plans/${planId}?key=${apiKey}`;
    const patchUrl  = `${docUrl}&updateMask.fieldPaths=strava_activity_ids`;

    const fields = {};
    Object.keys(dateToId).forEach(date => {
      fields[date] = { stringValue: String(dateToId[date]) };
    });

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { strava_activity_ids: { mapValue: { fields } } } }),
    });

    if (!patchRes.ok) throw new Error(`Firebase PATCH failed: ${await patchRes.text()}`);

    return {
      statusCode: 200,
      body: `Backfilled ${Object.keys(dateToId).length} dates with activity IDs. Safe to delete this function now.`,
    };

  } catch (err) {
    console.error('[backfill] Error:', err);
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};
