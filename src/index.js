
function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  if (month <= 3) return 'WINTER';
  if (month <= 6) return 'SPRING';
  if (month <= 9) return 'SUMMER';
  return 'FALL';
}

const ANILIST_QUERY = `
query ($username: String) {
  User(name: $username) {
    statistics {
      anime {
        statuses {
          count
          status
        }
      }
    }
  }
  currentWatching: MediaListCollection(userName: $username, type: ANIME, status: CURRENT, sort: UPDATED_TIME_DESC) {
    lists {
      entries {
        progress
        score(format: POINT_100)
        updatedAt
        media {
          id
          title {
            english
            romaji
          }
          coverImage {
            large
          }
          episodes
          season
          seasonYear
        }
      }
    }
  }
  completedList: MediaListCollection(userName: $username, type: ANIME, status: COMPLETED) {
    lists {
      entries {
        progress
        score(format: POINT_100)
        updatedAt
        media {
          id
          title {
            english
            romaji
          }
          coverImage {
            large
          }
          episodes
        }
        completedAt {
          year
        }
      }
    }
  }
}
`;

async function fetchAnilistData(username, proxyUrl, proxySecret) {
  console.log(`[anilist] fetching data for user: ${username}`);
  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Proxy-Secret': proxySecret,
    },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { username },
    }),
  });

  console.log(`[anilist] response status: ${response.status}`);

  if (!response.ok) {
    const body = await response.text();
    console.error(`[anilist] error body: ${body.slice(0, 500)}`);
    throw new Error(`AniList API responded with ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    console.error(`[anilist] GraphQL errors: ${JSON.stringify(json.errors)}`);
    throw new Error(`AniList GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  console.log('[anilist] data fetched successfully');
  return json.data;
}

function deduplicateByMediaId(entries) {
  const seen = new Set();
  return entries.filter(e => {
    const id = e.media?.id;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function processData(data) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const lastYear = currentYear - 1;
  const currentSeason = getCurrentSeason();

  console.log(`[process] season=${currentSeason} year=${currentYear}`);

  const { User, currentWatching, completedList } = data;

  if (!User) throw new Error('AniList user not found or profile is private');

  const statuses = User.statistics.anime.statuses ?? [];
  const getStatusCount = (status) => {
    const stat = statuses.find(s => s.status === status);
    return stat ? stat.count : 0;
  };

  // CURRENT entries — used for season count
  const allWatchingRaw = (currentWatching?.lists ?? []).flatMap(l => l.entries);
  const watchingEntries = deduplicateByMediaId(allWatchingRaw)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // COMPLETED entries — used for year counts and last-activity detection
  const allCompleted = deduplicateByMediaId((completedList?.lists ?? []).flatMap(l => l.entries));

  // Last activity = most recently updated across CURRENT and COMPLETED
  // so finishing an anime shows up immediately
  const completedIds = new Set(allCompleted.map(e => e.media?.id));
  const lastEntry = [...watchingEntries, ...allCompleted]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const lastEntryStatus = lastEntry
    ? (completedIds.has(lastEntry.media?.id) ? 'COMPLETED' : 'CURRENT')
    : 'CURRENT';
  const infoTextMap = { CURRENT: 'Watched', COMPLETED: 'Finished', PLANNING: 'Planning' };
  const infoText = infoTextMap[lastEntryStatus] ?? 'Watched';

  if (lastEntry) {
    console.log(`[process] last activity: "${lastEntry.media?.title?.english || lastEntry.media?.title?.romaji}" ep=${lastEntry.progress} score=${lastEntry.score} updatedAt=${lastEntry.updatedAt}`);
  } else {
    console.log('[process] no activity found');
  }

  console.log(`[process] watching entries (deduped): ${watchingEntries.length}`);

  const currentSeasonCount = watchingEntries.filter(
    e => e.media.season === currentSeason && e.media.seasonYear === currentYear
  ).length;

  const thisYearCount = allCompleted.filter(e => e.completedAt?.year === currentYear).length;
  const lastYearCount = allCompleted.filter(e => e.completedAt?.year === lastYear).length;

  console.log(`[process] this_season=${currentSeasonCount} total_watching=${getStatusCount('CURRENT')} planning=${getStatusCount('PLANNING')} completed=${getStatusCount('COMPLETED')} this_year=${thisYearCount} last_year=${lastYearCount}`);

  return {
    animeName: lastEntry?.media?.title?.english || lastEntry?.media?.title?.romaji || 'N/A',
    progress: lastEntry?.progress ?? 0,
    episodes: lastEntry?.media?.episodes ?? '?',
    thumbnail: lastEntry?.media?.coverImage?.large ?? '',
    score: lastEntry?.score ?? 0,
    infoText,
    currentSeasonCount,
    totalWatching: getStatusCount('CURRENT'),
    totalPlanning: getStatusCount('PLANNING'),
    totalCompleted: getStatusCount('COMPLETED'),
    thisYearCount,
    lastYearCount,
  };
}

function buildPayload(stats) {
  return {
    data: {
      dynamic: [
        { type: 1, name: 'current_info_text', value: stats.infoText },
        { type: 1, name: 'score', value: `Tentative Score : ${stats.score}` },
        { type: 3, name: 'last_anime_pic', value: { url: stats.thumbnail } },
        { type: 1, name: 'episode', value: `Episode : ${stats.progress} of ${stats.episodes}` },
        { type: 1, name: 'anime_name', value: stats.animeName },
        { type: 2, name: 'currently_watching_this_season', value: stats.currentSeasonCount },
        { type: 2, name: 'total_watching', value: stats.totalWatching },
        { type: 2, name: 'total_planning', value: stats.totalPlanning },
        { type: 2, name: 'total_watched', value: stats.totalCompleted },
        { type: 2, name: 'this_year_total', value: stats.thisYearCount },
        { type: 2, name: 'last_year_total', value: stats.lastYearCount },
      ],
    },
  };
}

async function postToDiscord(payload, endpoint, token) {
  console.log('[discord] sending PATCH:', JSON.stringify(payload));
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Accept': '*/*',
      'Accept-Encoding': 'deflate, gzip',
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)',
    },
    body: JSON.stringify(payload),
  });

  console.log(`[discord] response status: ${response.status}`);

  if (!response.ok) {
    const body = await response.text();
    console.error(`[discord] error body: ${body}`);
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  // 204 No Content is a valid success response — no body to parse
  if (response.status === 204) {
    console.log('[discord] widget updated successfully (204 No Content)');
    return null;
  }

  const result = await response.json();
  console.log('[discord] response body:', JSON.stringify(result));
  return result;
}

async function run(env) {
  console.log('[run] starting update');
  const data = await fetchAnilistData(env.ANILIST_USERNAME, env.ANILIST_PROXY_URL, env.PROXY_SECRET);
  const stats = processData(data);
  const payload = buildPayload(stats);
  const result = await postToDiscord(payload, env.DISCORD_ENDPOINT, env.BOT_TOKEN);
  console.log('[run] update complete');
  return { stats, result };
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[scheduled] cron fired: ${event.cron}`);
    try {
      await run(env);
      console.log('[scheduled] done');
    } catch (err) {
      console.error(`[scheduled] failed: ${err.message}`);
    }
  },

  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const secret = request.headers.get('X-Trigger-Secret');
    if (!secret || secret !== env.TRIGGER_SECRET) {
      console.warn('[fetch] unauthorized trigger attempt');
      return new Response('Unauthorized', { status: 401 });
    }
    console.log('[fetch] manual trigger authorized');
    try {
      const { stats } = await run(env);
      return new Response(JSON.stringify({ success: true, stats }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error(`[fetch] failed: ${err.message}`);
      return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
