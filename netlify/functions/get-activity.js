// ── Get Activity Details ─────────────────────────────────────
// Netlify Function: netlify/functions/get-activity.js
//
// Called from the browser when someone taps a session card.
// Given a Strava activity ID, returns just enough data to draw
// a map and a splits table, nothing more.
//
// Frontend calls it like:
//   fetch('/.netlify/functions/get-activity?id=16019283746')
//
// Uses the same Strava environment variables as strava-webhook.js:
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
// No Firebase needed here, and no athlete-specific settings: HR zones live in
// the plan page itself, which buckets the raw histogram this returns.

// ── Strava: refresh access token (identical to strava-webhook.js) ──
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

exports.handler = async (event) => {
  const activityId = (event.queryStringParameters || {}).id;
  if (!activityId) {
    return { statusCode: 400, body: 'Missing ?id=' };
  }

  try {
    const accessToken = await refreshStravaToken();

    // Two Strava calls: the GPS/HR/pace time-series, and the lap splits.
    const [streamsRes, lapsRes] = await Promise.all([
      fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=latlng,heartrate,velocity_smooth,distance,altitude,cadence,time&key_by_type=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ),
      fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/laps`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ),
    ]);

    if (!streamsRes.ok) throw new Error(`Strava streams ${streamsRes.status}`);
    if (!lapsRes.ok) throw new Error(`Strava laps ${lapsRes.status}`);

    const streams = await streamsRes.json();
    const laps = await lapsRes.json();

    // Raw streams can be thousands of points. Downsample to ~120 evenly-spaced
    // samples so the payload stays small and the charts draw smoothly.
    function downsample(arr, target) {
      if (!arr || arr.length <= target) return arr || [];
      const step = arr.length / target;
      const out = [];
      for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]);
      return out;
    }

    const TARGET = 120;
    const hrRaw = streams.heartrate ? streams.heartrate.data : [];
    const paceRaw = streams.velocity_smooth ? streams.velocity_smooth.data : [];
    const distRaw = streams.distance ? streams.distance.data : [];
    const altRaw = streams.altitude ? streams.altitude.data : [];
    const cadRaw = streams.cadence ? streams.cadence.data : [];
    const timeRaw = streams.time ? streams.time.data : [];

    // Convert velocity (m/s) to pace (seconds per km) for each sample.
    // Guard against zero/near-zero speed (standing still) producing absurd paces.
    const paceSecPerKm = paceRaw.map(v => (v && v > 0.5) ? Math.round(1000 / v) : null);

    // Strava reports cadence per leg — double it for real-world spm.
    const cadFull = cadRaw.map(c => (c != null) ? c * 2 : null);

    // ── Time spent at each heart rate (seconds per bpm) ──
    // Deliberately NOT bucketed into zones here. The plan page already lists
    // this athlete's own zone boundaries, so it does the bucketing itself.
    // That means a plan generated for a different athlete shows their zones
    // automatically, with nothing to configure on the server.
    // Computed from the full stream, not the downsampled version, so it's exact.
    let hrHistogram = null;
    if (hrRaw.length) {
      const hist = new Array(256).fill(0);
      const hasTime = timeRaw.length === hrRaw.length;
      for (let i = 0; i < hrRaw.length; i++) {
        const hr = hrRaw[i];
        if (hr == null || hr < 1 || hr > 255) continue; // 0 = sensor dropout, not a real reading
        let dt = 1;
        if (hasTime && i < hrRaw.length - 1) dt = Math.max(0, timeRaw[i + 1] - timeRaw[i]);
        hist[hr] += dt;
      }
      hrHistogram = hist.map(v => Math.round(v));
    }

    // Trim this down to only what a session card actually needs to draw,
    // no point shipping the full raw Strava response to the browser.
    const result = {
      map: streams.latlng ? streams.latlng.data : [],          // [[lat,lng], [lat,lng], ...]
      hr: downsample(hrRaw, TARGET),                            // [bpm, bpm, ...]
      pace: downsample(paceSecPerKm, TARGET),                  // [s/km, s/km, ...]
      distKm: downsample(distRaw, TARGET).map(d => Math.round((d / 1000) * 100) / 100), // [km, km, ...]
      elevation: downsample(altRaw, TARGET).map(a => a != null ? Math.round(a) : null), // [m, m, ...]
      cadence: downsample(cadFull, TARGET),                     // [spm, spm, ...]
      hrHistogram: hrHistogram,                                 // [secondsAtBpm0, ...bpm255] or null; the page buckets this into its own zones
      splits: laps.map(l => {
        const distM = Math.round(l.distance);
        const timeS = l.moving_time;
        // Compute pace from distance + time (both already reliable here) rather
        // than average_speed, which the Strava API doesn't always populate.
        // sec/km = time / (distance in km). Null only if distance is missing.
        const paceSecPerKm = (distM > 0 && timeS > 0) ? Math.round(timeS / (distM / 1000)) : null;
        return {
          lap: l.lap_index,
          distanceM: distM,
          movingTimeS: timeS,
          paceSecPerKm: paceSecPerKm,
          avgHr: l.average_heartrate ? Math.round(l.average_heartrate) : null,
        };
      }),
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('[get-activity] Error:', err);
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};
