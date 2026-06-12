/**
 * subgraphs/users/index.js
 *
 * Users Subgraph — owns: User, Profile, Preferences
 * Port: 4001
 *
 * This subgraph is the source of truth for the User entity.
 * Other subgraphs (content, billing) reference @key(fields: "id")
 * and extend User with their own fields.
 */

'use strict';

// ── Tracing must be initialized FIRST, before any other requires ──
const { initTracer } = require('../../observability/tracer');
const tracer = initTracer('users-subgraph');

const { ApolloServer } = require('@apollo/server');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const { expressMiddleware } = require('@apollo/server/express4');
const { fieldAnalyticsPlugin } = require('../../observability/fieldAnalytics');
const express = require('express');
const { gql } = require('graphql-tag');
const opentelemetry = require('@opentelemetry/api');

const PORT = process.env.PORT || 4001;

// ── Fake data store (swap for Postgres/DynamoDB) ──────────────────
const USERS = [
  {
    id: 'u1', email: 'alice@netflix.com', name: 'Alice Hoffman',
    plan: 'PREMIUM', country: 'US', memberSince: '2019-03-15',
    profiles: [
      { id: 'p1', name: 'Alice', avatarUrl: 'https://i.pravatar.cc/150?u=alice', maturityRating: 'ALL' },
      { id: 'p2', name: 'Kids', avatarUrl: 'https://i.pravatar.cc/150?u=kids', maturityRating: 'KIDS' },
    ],
  },
  {
    id: 'u2', email: 'bob@netflix.com', name: 'Bob Chen',
    plan: 'STANDARD', country: 'CA', memberSince: '2021-07-22',
    profiles: [
      { id: 'p3', name: 'Bob', avatarUrl: 'https://i.pravatar.cc/150?u=bob', maturityRating: 'ALL' },
    ],
  },
  {
    id: 'u3', email: 'carol@netflix.com', name: 'Carol Martinez',
    plan: 'BASIC', country: 'MX', memberSince: '2022-11-01',
    profiles: [
      { id: 'p4', name: 'Carol', avatarUrl: 'https://i.pravatar.cc/150?u=carol', maturityRating: 'ALL' },
    ],
  },
];

// ── Schema ────────────────────────────────────────────────────────
const typeDefs = gql`
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.0",
          import: ["@key", "@shareable"])

  """
  A Netflix member account. Entity — referenced by billing and content subgraphs.
  """
  type User @key(fields: "id") {
    id: ID!
    email: String!
    name: String!
    plan: MembershipPlan!
    country: String!
    memberSince: String!
    profiles: [Profile!]!
  }

  type Profile @key(fields: "id") {
    id: ID!
    name: String!
    avatarUrl: String
    maturityRating: MaturityRating!
  }

  enum MembershipPlan {
    BASIC
    STANDARD
    PREMIUM
  }

  enum MaturityRating {
    KIDS
    ALL
    ADULT
  }

  type Query {
    me(userId: ID!): User
    user(id: ID!): User
    users: [User!]!
  }

  type Mutation {
    updateProfile(profileId: ID!, name: String!): Profile
  }
`;

// ── Resolvers ─────────────────────────────────────────────────────
const resolvers = {
  Query: {
    me: async (_, { userId }, context) => {
      const span = tracer.startSpan('resolver.me', {
        attributes: { 'graphql.resolver': 'me', 'user.id': userId },
      });
      try {
        const user = USERS.find(u => u.id === userId);
        span.setAttribute('found', !!user);
        return user ?? null;
      } finally {
        span.end();
      }
    },

    user: (_, { id }) => USERS.find(u => u.id === id) ?? null,

    users: () => USERS,
  },

  Mutation: {
    updateProfile: (_, { profileId, name }) => {
      for (const user of USERS) {
        const profile = user.profiles.find(p => p.id === profileId);
        if (profile) {
          profile.name = name;
          return profile;
        }
      }
      throw new Error(`Profile ${profileId} not found`);
    },
  },

  // Federation entity resolvers
  User: {
    __resolveReference: (ref) => USERS.find(u => u.id === ref.id),
    profiles: (user) => user.profiles,
  },

  Profile: {
    __resolveReference: (ref) => {
      for (const user of USERS) {
        const p = user.profiles.find(p => p.id === ref.id);
        if (p) return p;
      }
    },
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

  // Health check
  app.get('/health', (_, res) => res.json({ status: 'ok', service: 'users-subgraph', port: PORT }));

  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req }) => ({
        clientName: req.headers['x-client-name'] || 'unknown',
        traceId: req.headers['x-trace-id'] || null,
      }),
    })
  );

  app.listen(PORT, () => {
    console.log(`✅ Users subgraph running at http://localhost:${PORT}/graphql`);
  });
}

start().catch(console.error);
