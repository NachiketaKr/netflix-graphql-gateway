/**
 * subgraphs/billing/index.js
 *
 * Billing Subgraph — owns: Subscription, Invoice, PaymentMethod
 * Port: 4003
 *
 * Extends User with subscription and invoice data.
 * Auth note: In production, billing resolvers would enforce strict
 * authorization — users can only access their own billing data.
 */

'use strict';

const { initTracer } = require('../../observability/tracer');
const tracer = initTracer('billing-subgraph');

const { ApolloServer } = require('@apollo/server');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const { expressMiddleware } = require('@apollo/server/express4');
const { fieldAnalyticsPlugin } = require('../../observability/fieldAnalytics');
const express = require('express');
const { gql } = require('graphql-tag');
const { GraphQLError } = require('graphql');

const PORT = process.env.PORT || 4003;

// ── Fake data store ───────────────────────────────────────────────
const SUBSCRIPTIONS = {
  u1: {
    id: 'sub1', userId: 'u1', plan: 'PREMIUM', status: 'ACTIVE',
    priceUsd: 22.99, billingCycleDay: 15,
    nextBillingDate: '2025-06-15', startDate: '2019-03-15',
    paymentMethod: { last4: '4242', brand: 'VISA', expiryMonth: 12, expiryYear: 2027 },
  },
  u2: {
    id: 'sub2', userId: 'u2', plan: 'STANDARD', status: 'ACTIVE',
    priceUsd: 15.49, billingCycleDay: 22,
    nextBillingDate: '2025-06-22', startDate: '2021-07-22',
    paymentMethod: { last4: '1234', brand: 'MASTERCARD', expiryMonth: 8, expiryYear: 2026 },
  },
  u3: {
    id: 'sub3', userId: 'u3', plan: 'BASIC', status: 'PAST_DUE',
    priceUsd: 6.99, billingCycleDay: 1,
    nextBillingDate: '2025-06-01', startDate: '2022-11-01',
    paymentMethod: { last4: '9999', brand: 'AMEX', expiryMonth: 3, expiryYear: 2025 },
  },
};

const INVOICES = {
  u1: [
    { id: 'inv1', amount: 22.99, currency: 'USD', status: 'PAID', date: '2025-05-15', description: 'Netflix Premium — May 2025' },
    { id: 'inv2', amount: 22.99, currency: 'USD', status: 'PAID', date: '2025-04-15', description: 'Netflix Premium — April 2025' },
    { id: 'inv3', amount: 22.99, currency: 'USD', status: 'PAID', date: '2025-03-15', description: 'Netflix Premium — March 2025' },
  ],
  u2: [
    { id: 'inv4', amount: 15.49, currency: 'USD', status: 'PAID', date: '2025-05-22', description: 'Netflix Standard — May 2025' },
  ],
  u3: [
    { id: 'inv5', amount: 6.99, currency: 'USD', status: 'FAILED', date: '2025-06-01', description: 'Netflix Basic — June 2025' },
  ],
};

// ── Schema ────────────────────────────────────────────────────────
const typeDefs = gql`
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.0",
          import: ["@key", "@external", "@extends"])

  type Subscription @key(fields: "id") {
    id: ID!
    plan: String!
    status: SubscriptionStatus!
    priceUsd: Float!
    nextBillingDate: String!
    startDate: String!
    paymentMethod: PaymentMethod!
  }

  type PaymentMethod {
    last4: String!
    brand: CardBrand!
    expiryMonth: Int!
    expiryYear: Int!
  }

  type Invoice @key(fields: "id") {
    id: ID!
    amount: Float!
    currency: String!
    status: InvoiceStatus!
    date: String!
    description: String!
  }

  enum SubscriptionStatus {
    ACTIVE
    CANCELLED
    PAST_DUE
    PAUSED
  }

  enum InvoiceStatus {
    PAID
    PENDING
    FAILED
    REFUNDED
  }

  enum CardBrand {
    VISA
    MASTERCARD
    AMEX
    DISCOVER
  }

  """
  Extend User with billing-domain fields.
  Authorization lives here — billing team controls access policy.
  """
  type User @key(fields: "id") @extends {
    id: ID! @external
    subscription: Subscription
    invoices: [Invoice!]!
    billingHealth: BillingHealth!
  }

  type BillingHealth {
    isHealthy: Boolean!
    issues: [String!]!
  }

  type Query {
    subscription(id: ID!): Subscription
    invoice(id: ID!): Invoice
  }

  type Mutation {
    cancelSubscription(userId: ID!): Subscription
    retryPayment(invoiceId: ID!): Invoice
  }
`;

// ── Resolvers ─────────────────────────────────────────────────────
const resolvers = {
  Query: {
    subscription: (_, { id }) => {
      return Object.values(SUBSCRIPTIONS).find(s => s.id === id);
    },
    invoice: (_, { id }) => {
      for (const invs of Object.values(INVOICES)) {
        const inv = invs.find(i => i.id === id);
        if (inv) return inv;
      }
      return null;
    },
  },

  Mutation: {
    cancelSubscription: (_, { userId }) => {
      const sub = SUBSCRIPTIONS[userId];
      if (!sub) throw new GraphQLError('Subscription not found', { extensions: { code: 'NOT_FOUND' } });
      sub.status = 'CANCELLED';
      return sub;
    },
    retryPayment: (_, { invoiceId }) => {
      for (const invs of Object.values(INVOICES)) {
        const inv = invs.find(i => i.id === invoiceId);
        if (inv) {
          inv.status = 'PAID';
          return inv;
        }
      }
      throw new GraphQLError('Invoice not found', { extensions: { code: 'NOT_FOUND' } });
    },
  },

  User: {
    __resolveReference: (ref) => ({ id: ref.id }),

    subscription: (user) => {
      const span = tracer.startSpan('resolver.user.subscription', {
        attributes: { 'user.id': user.id },
      });
      try {
        return SUBSCRIPTIONS[user.id] || null;
      } finally {
        span.end();
      }
    },

    invoices: (user) => INVOICES[user.id] || [],

    billingHealth: (user) => {
      const sub = SUBSCRIPTIONS[user.id];
      const issues = [];
      if (!sub) return { isHealthy: false, issues: ['No subscription found'] };
      if (sub.status === 'PAST_DUE') issues.push('Payment past due');
      if (sub.status === 'CANCELLED') issues.push('Subscription cancelled');
      const expiry = new Date(sub.paymentMethod.expiryYear, sub.paymentMethod.expiryMonth - 1);
      if (expiry < new Date()) issues.push('Payment method expired');
      return { isHealthy: issues.length === 0, issues };
    },
  },

  Subscription: {
    __resolveReference: (ref) => Object.values(SUBSCRIPTIONS).find(s => s.id === ref.id),
  },

  Invoice: {
    __resolveReference: (ref) => {
      for (const invs of Object.values(INVOICES)) {
        const inv = invs.find(i => i.id === ref.id);
        if (inv) return inv;
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
  app.get('/health', (_, res) => res.json({ status: 'ok', service: 'billing-subgraph', port: PORT }));

  app.use('/graphql', expressMiddleware(server, {
    context: async ({ req }) => ({
      clientName: req.headers['x-client-name'] || 'unknown',
    }),
  }));

  app.listen(PORT, () => {
    console.log(`✅ Billing subgraph running at http://localhost:${PORT}/graphql`);
  });
}

start().catch(console.error);
