/**
 * subgraphs/content/index.js
 *
 * Content Subgraph — owns: Title, Genre, WatchHistory, ContinueWatching
 * Port: 4002
 *
 * Extends the User entity (owned by users-subgraph) with
 * watchHistory and recommendations — this is the federation pattern
 * Netflix uses where domain teams own their data but share entities.
 */

'use strict';

const { initTracer } = require('../../observability/tracer');
const tracer = initTracer('content-subgraph');

const { ApolloServer } = require('@apollo/server');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const { expressMiddleware } = require('@apollo/server/express4');
const { fieldAnalyticsPlugin } = require('../../observability/fieldAnalytics');
const express = require('express');
const { gql } = require('graphql-tag');

const PORT = process.env.PORT || 4002;

// ── Fake data store ───────────────────────────────────────────────
const TITLES = [
  { id: 't1', title: 'Stranger Things', type: 'SERIES', genre: 'SCIFI', year: 2016, rating: 8.7, maturityRating: 'TV-14', description: 'A group of kids uncover supernatural mysteries in their small town.', thumbnailUrl: 'https://picsum.photos/seed/st/320/180', seasons: 4 },
  { id: 't2', title: 'The Crown', type: 'SERIES', genre: 'DRAMA', year: 2016, rating: 8.6, maturityRating: 'TV-MA', description: 'The reign of Queen Elizabeth II from the 1940s onward.', thumbnailUrl: 'https://picsum.photos/seed/crown/320/180', seasons: 6 },
  { id: 't3', title: 'Inception', type: 'MOVIE', genre: 'THRILLER', year: 2010, rating: 8.8, maturityRating: 'PG-13', description: 'A thief who steals corporate secrets through dream-sharing technology.', thumbnailUrl: 'https://picsum.photos/seed/inception/320/180', durationMins: 148 },
  { id: 't4', title: 'Squid Game', type: 'SERIES', genre: 'THRILLER', year: 2021, rating: 8.0, maturityRating: 'TV-MA', description: 'Desperate people compete in deadly children\'s games for a cash prize.', thumbnailUrl: 'https://picsum.photos/seed/squid/320/180', seasons: 2 },
  { id: 't5', title: 'The Power of the Dog', type: 'MOVIE', genre: 'DRAMA', year: 2021, rating: 6.8, maturityRating: 'R', description: 'A charismatic rancher terrorizes his brother\'s new wife and her son.', thumbnailUrl: 'https://picsum.photos/seed/dog/320/180', durationMins: 126 },
  { id: 't6', title: 'Ozark', type: 'SERIES', genre: 'DRAMA', year: 2017, rating: 8.4, maturityRating: 'TV-MA', description: 'A financial advisor drags his family to the Ozarks to launder money.', thumbnailUrl: 'https://picsum.photos/seed/ozark/320/180', seasons: 4 },
];

const WATCH_HISTORY = {
  u1: [
    { titleId: 't1', progressPercent: 100, lastWatchedAt: '2025-05-01T20:00:00Z' },
    { titleId: 't3', progressPercent: 67, lastWatchedAt: '2025-05-10T22:30:00Z' },
    { titleId: 't4', progressPercent: 100, lastWatchedAt: '2025-04-20T19:00:00Z' },
  ],
  u2: [
    { titleId: 't2', progressPercent: 45, lastWatchedAt: '2025-05-15T21:00:00Z' },
    { titleId: 't6', progressPercent: 100, lastWatchedAt: '2025-03-10T20:00:00Z' },
  ],
  u3: [
    { titleId: 't5', progressPercent: 88, lastWatchedAt: '2025-05-18T18:00:00Z' },
  ],
};

// Simple collaborative filtering: recommend titles in same genres as watched
function getRecommendations(userId) {
  const history = WATCH_HISTORY[userId] || [];
  const watchedIds = new Set(history.map(h => h.titleId));
  const watchedGenres = history
    .map(h => TITLES.find(t => t.id === h.titleId)?.genre)
    .filter(Boolean);
  return TITLES
    .filter(t => !watchedIds.has(t.id) && watchedGenres.includes(t.genre))
    .slice(0, 3);
}

// ── Schema ────────────────────────────────────────────────────────
const typeDefs = gql`
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.0",
          import: ["@key", "@external", "@extends", "@requires"])

  type Title @key(fields: "id") {
    id: ID!
    title: String!
    type: TitleType!
    genre: Genre!
    year: Int!
    rating: Float!
    maturityRating: String!
    description: String!
    thumbnailUrl: String!
    seasons: Int
    durationMins: Int
  }

  type WatchEntry {
    title: Title!
    progressPercent: Int!
    lastWatchedAt: String!
  }

  enum TitleType {
    MOVIE
    SERIES
  }

  enum Genre {
    ACTION
    COMEDY
    DRAMA
    SCIFI
    THRILLER
    DOCUMENTARY
    HORROR
  }

  """
  Extend User from the users-subgraph with content-domain fields.
  This is the Netflix federation pattern — content team owns this extension.
  """
  type User @key(fields: "id") @extends {
    id: ID! @external
    watchHistory: [WatchEntry!]!
    recommendations: [Title!]!
    continueWatching: [WatchEntry!]!
  }

  type Query {
    title(id: ID!): Title
    titles(genre: Genre, type: TitleType): [Title!]!
    search(query: String!): [Title!]!
    trending: [Title!]!
  }
`;

// ── Resolvers ─────────────────────────────────────────────────────
const resolvers = {
  Query: {
    title: (_, { id }) => TITLES.find(t => t.id === id),

    titles: (_, { genre, type }) => {
      const span = tracer.startSpan('resolver.titles', {
        attributes: { 'filter.genre': genre || 'all', 'filter.type': type || 'all' },
      });
      try {
        return TITLES.filter(t =>
          (!genre || t.genre === genre) && (!type || t.type === type)
        );
      } finally {
        span.end();
      }
    },

    search: (_, { query }) => {
      const q = query.toLowerCase();
      return TITLES.filter(t =>
        t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      );
    },

    trending: () => [...TITLES].sort((a, b) => b.rating - a.rating).slice(0, 4),
  },

  // Entity resolver — gateway calls this to hydrate User from users-subgraph
  User: {
    __resolveReference: (ref) => ({ id: ref.id }),

    watchHistory: (user) => {
      const history = WATCH_HISTORY[user.id] || [];
      return history.map(h => ({
        title: TITLES.find(t => t.id === h.titleId),
        progressPercent: h.progressPercent,
        lastWatchedAt: h.lastWatchedAt,
      }));
    },

    recommendations: (user) => getRecommendations(user.id),

    continueWatching: (user) => {
      const history = WATCH_HISTORY[user.id] || [];
      return history
        .filter(h => h.progressPercent > 0 && h.progressPercent < 100)
        .map(h => ({
          title: TITLES.find(t => t.id === h.titleId),
          progressPercent: h.progressPercent,
          lastWatchedAt: h.lastWatchedAt,
        }));
    },
  },

  Title: {
    __resolveReference: (ref) => TITLES.find(t => t.id === ref.id),
  },
};

// ── Server bootstrap ──────────────────────────────────────────────
async function start() {
  const server = new ApolloServer({
    schema: buildSubgraphSchema({ typeDefs, resolvers }),
    plugins: [fieldAnalyticsPlugin()],
  });

  await server.start();

  const app = express();
  app.use(express.json());
  app.get('/health', (_, res) => res.json({ status: 'ok', service: 'content-subgraph', port: PORT }));

  app.use('/graphql', expressMiddleware(server, {
    context: async ({ req }) => ({
      clientName: req.headers['x-client-name'] || 'unknown',
    }),
  }));

  app.listen(PORT, () => {
    console.log(`✅ Content subgraph running at http://localhost:${PORT}/graphql`);
  });
}

start().catch(console.error);
