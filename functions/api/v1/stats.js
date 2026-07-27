// Agrège les événements stockés dans KV et renvoie des statistiques anonymes.
// Protégé par une clé secrète (variable d'environnement STATS_SECRET) passée en
// paramètre d'URL : /api/v1/stats?key=VOTRE_CLE

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!env.STATS_SECRET || key !== env.STATS_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SRACTIVE_EVENTS) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

  function emptyBucket() {
    return {
      sessions: new Set(),
      bySite: {},
      views: {},
      chaptersOpened: {},
      chaptersCompleted: {},
      quiz: {},
      circuitsStarted: 0,
      totalEvents: 0,
    };
  }

  const all = emptyBucket();
  const recent = emptyBucket(); // derniers 3 jours

  function ingest(bucket, evt) {
    bucket.totalEvents++;
    if (evt.session_id) bucket.sessions.add(evt.session_id);
    const site = evt.site_code || 'inconnu';
    bucket.bySite[site] = (bucket.bySite[site] || 0) + 1;

    const d = evt.data || {};
    if (evt.event_name === 'view_change') {
      const v = d.view || 'inconnu';
      bucket.views[v] = (bucket.views[v] || 0) + 1;
    }
    if (evt.event_name === 'chapter_open') {
      const c = d.chapter_id || 'inconnu';
      bucket.chaptersOpened[c] = (bucket.chaptersOpened[c] || 0) + 1;
    }
    if (evt.event_name === 'chapter_complete') {
      const c = d.chapter_id || 'inconnu';
      bucket.chaptersCompleted[c] = (bucket.chaptersCompleted[c] || 0) + 1;
    }
    if (evt.event_name === 'quiz_complete') {
      const c = d.chapter_id || 'inconnu';
      if (!bucket.quiz[c]) bucket.quiz[c] = { count: 0, sumPercent: 0 };
      bucket.quiz[c].count++;
      bucket.quiz[c].sumPercent += (d.percent || 0);
    }
    if (evt.event_name === 'circuit_start') {
      bucket.circuitsStarted++;
    }
  }

  let cursor;
  do {
    const list = await env.SRACTIVE_EVENTS.list({ prefix: 'evt:', cursor, limit: 1000 });
    for (const k of list.keys) {
      // Horodatage extrait directement du nom de clé : evt:<timestamp>:<random>
      const parts = k.name.split(':');
      const ts = Number(parts[1]) || 0;

      const raw = await env.SRACTIVE_EVENTS.get(k.name);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { continue; }
      const evts = Array.isArray(parsed) ? parsed : [parsed];

      for (const evt of evts) {
        ingest(all, evt);
        if (ts >= threeDaysAgo) ingest(recent, evt);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  function summarize(bucket) {
    const quizAveragePercent = {};
    for (const [c, v] of Object.entries(bucket.quiz)) {
      quizAveragePercent[c] = Math.round(v.sumPercent / v.count);
    }
    const completionRateByChapter = {};
    for (const [c, opened] of Object.entries(bucket.chaptersOpened)) {
      const completed = bucket.chaptersCompleted[c] || 0;
      completionRateByChapter[c] = opened > 0 ? Math.round((completed / opened) * 100) : 0;
    }
    return {
      total_events: bucket.totalEvents,
      unique_sessions: bucket.sessions.size,
      by_site: bucket.bySite,
      views: bucket.views,
      chapters_opened: bucket.chaptersOpened,
      chapters_completed: bucket.chaptersCompleted,
      completion_rate_by_chapter: completionRateByChapter,
      quiz_average_percent: quizAveragePercent,
      circuits_started: bucket.circuitsStarted,
    };
  }

  return json({
    ok: true,
    generated_at: new Date(now).toISOString(),
    all_time: summarize(all),
    last_3_days: {
      since: new Date(threeDaysAgo).toISOString(),
      ...summarize(recent),
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
