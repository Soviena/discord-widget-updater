const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

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
        completedAt {
          year
        }
      }
    }
  }
}
`;

async function fetchAnilistData(username) {
  const response = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { username },
    }),
  });

  if (!response.ok) {
    throw new Error(`AniList API responded with ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`AniList GraphQL error: ${JSON.stringify(json.errors)}`);
  }
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

  const { User, currentWatching, completedList } = data;

  const getStatusCount = (status) => {
    const stat = User.statistics.anime.statuses.find(s => s.status === status);
    return stat ? stat.count : 0;
  };

  // Deduplicate to avoid counting custom list duplicates
  const allWatchingRaw = currentWatching.lists.flatMap(l => l.entries);
  const watchingEntries = deduplicateByMediaId(allWatchingRaw);

  const lastEntry = watchingEntries[0];

  const currentSeasonCount = watchingEntries.filter(
    e => e.media.season === currentSeason && e.media.seasonYear === currentYear
  ).length;

  const allCompleted = completedList.lists.flatMap(l => l.entries);
  const thisYearCount = allCompleted.filter(e => e.completedAt?.year === currentYear).length;
  const lastYearCount = allCompleted.filter(e => e.completedAt?.year === lastYear).length;

  return {
    animeName: lastEntry?.media?.title?.english || lastEntry?.media?.title?.romaji || 'N/A',
    progress: lastEntry?.progress ?? 0,
    episodes: lastEntry?.media?.episodes ?? '?',
    thumbnail: lastEntry?.media?.coverImage?.large ?? '',
    score: lastEntry?.score ?? 0,
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  return response.json();
}

async function run(env) {
  const data = await fetchAnilistData(env.ANILIST_USERNAME);
  const stats = processData(data);
  const payload = buildPayload(stats);
  const result = await postToDiscord(payload, env.DISCORD_ENDPOINT, env.BOT_TOKEN);
  return { stats, result };
}

export default {
  async scheduled(event, env, ctx) {
    try {
      await run(env);
      console.log('Discord widget updated successfully');
    } catch (err) {
      console.error('Update failed:', err.message);
    }
  },

  // Required by wrangler dev --test-scheduled even when workers_dev = false
  async fetch(request, env, ctx) {
    return new Response('Not Found', { status: 404 });
  },
};
