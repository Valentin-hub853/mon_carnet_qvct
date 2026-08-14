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
      sessionsBySite: {}, // site -> Set(session_id) — pour compter des personnes, pas des événements
      views: {},
      chaptersOpened: {},
      chaptersCompleted: {},
      quiz: {},
      circuitsStarted: 0,
      totalEvents: 0,
      jobProfile: {}, // intitulé de métier -> nombre
      jobBucket: {}, // bureau / industriel / mixte -> nombre
      needs: {}, // besoin sélectionné dans le générateur -> nombre
      challengeState: {}, // "session|chapitre" -> { chapterId, done, ts } — dernier état connu
      sessionDurations: [], // secondes, une entrée par session terminée
      dailyDuration: {}, // 'AAAA-MM-JJ' -> secondes cumulées ce jour-là
    };
  }

  const all = emptyBucket();
  const recent = emptyBucket(); // derniers 3 jours

  function ingest(bucket, evt) {
    bucket.totalEvents++;
    if (evt.session_id) bucket.sessions.add(evt.session_id);
    const site = evt.site_code || 'inconnu';
    bucket.bySite[site] = (bucket.bySite[site] || 0) + 1;
    if (evt.session_id) {
      if (!bucket.sessionsBySite[site]) bucket.sessionsBySite[site] = new Set();
      bucket.sessionsBySite[site].add(evt.session_id);
    }

    const d = evt.data || {};
    // Horodatage de l'événement lui-même (plus précis que celui du lot KV,
    // nécessaire pour ordonner les bascules de défi et regrouper par jour).
    const evtTs = evt.occurred_at ? Date.parse(evt.occurred_at) : 0;

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
    if (evt.event_name === 'intro_complete') {
      const jp = d.job_profile || 'inconnu';
      const jb = d.job_bucket || 'inconnu';
      bucket.jobProfile[jp] = (bucket.jobProfile[jp] || 0) + 1;
      bucket.jobBucket[jb] = (bucket.jobBucket[jb] || 0) + 1;
    }
    if (evt.event_name === 'routine_generated') {
      const n = d.need || 'inconnu';
      bucket.needs[n] = (bucket.needs[n] || 0) + 1;
    }
    if (evt.event_name === 'challenge_toggle') {
      const c = d.chapter_id || 'inconnu';
      const stateKey = `${evt.session_id || 'anonyme'}|${c}`;
      const prev = bucket.challengeState[stateKey];
      // On ne garde que le dernier état connu (une case peut être cochée puis décochée).
      if (!prev || evtTs >= prev.ts) {
        bucket.challengeState[stateKey] = { chapterId: c, done: !!d.done, ts: evtTs };
      }
    }
    if (evt.event_name === 'session_end') {
      const dur = Number(d.duration_seconds) || 0;
      bucket.sessionDurations.push(dur);
      const dayKey = evt.occurred_at ? evt.occurred_at.slice(0, 10) : 'inconnu';
      bucket.dailyDuration[dayKey] = (bucket.dailyDuration[dayKey] || 0) + dur;
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

    // Nombre de personnes (sessions uniques), pas d'événements, par outil connecté.
    const uniqueSessionsBySite = {};
    for (const [site, set] of Object.entries(bucket.sessionsBySite)) {
      uniqueSessionsBySite[site] = set.size;
    }

    // Défis relevés : on compte le dernier état connu par session + escale.
    let challengesCompleted = 0;
    const challengesByChapter = {};
    for (const entry of Object.values(bucket.challengeState)) {
      if (entry.done) {
        challengesCompleted++;
        challengesByChapter[entry.chapterId] = (challengesByChapter[entry.chapterId] || 0) + 1;
      }
    }

    // Temps moyen par jour : total du temps passé (toutes sessions) divisé par le
    // nombre de jours pendant lesquels l'application a été utilisée au moins une fois.
    const totalDailyDuration = Object.values(bucket.dailyDuration).reduce((a, b) => a + b, 0);
    const activeDaysCount = Object.keys(bucket.dailyDuration).length;
    const avgDailyMinutes = activeDaysCount > 0
      ? Math.round((totalDailyDuration / activeDaysCount) / 60)
      : 0;

    // Durée moyenne d'une session, à titre complémentaire.
    const totalSessionDuration = bucket.sessionDurations.reduce((a, b) => a + b, 0);
    const avgSessionMinutes = bucket.sessionDurations.length > 0
      ? Math.round((totalSessionDuration / bucket.sessionDurations.length) / 60 * 10) / 10
      : 0;

    return {
      total_events: bucket.totalEvents,
      unique_sessions: bucket.sessions.size,
      by_site: bucket.bySite,
      unique_sessions_by_site: uniqueSessionsBySite,
      views: bucket.views,
      chapters_opened: bucket.chaptersOpened,
      chapters_completed: bucket.chaptersCompleted,
      completion_rate_by_chapter: completionRateByChapter,
      quiz_average_percent: quizAveragePercent,
      circuits_started: bucket.circuitsStarted,
      job_profile: bucket.jobProfile,
      job_bucket: bucket.jobBucket,
      needs_requested: bucket.needs,
      challenges_completed: challengesCompleted,
      challenges_by_chapter: challengesByChapter,
      avg_daily_minutes: avgDailyMinutes,
      avg_session_minutes: avgSessionMinutes,
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
