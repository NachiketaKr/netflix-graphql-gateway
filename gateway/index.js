/**
 * gateway/index.js
 *
 * Federated GraphQL Gateway — inspired by Netflix Studio Edge
 *
 * Architecture (from Netflix Engineering Blog):
 *  - Apollo Gateway composes users/content/billing subgraphs into one supergraph
 *  - OpenTelemetry traces propagate via W3C traceparent headers to each subgraph
 *  - Field-level analytics track per-field usage for deprecation workflows
 *  - Auth happens AT the gateway — subgraphs trust the forwarded identity
 *
 * Port: 4000
 */

'use strict';

// OTel must initialize before anything else
const { initTracer } = require('../observability/tracer');
const tracer = initTracer('graphql-gateway');

const { ApolloServer } = require('@apollo/server');
const { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } = require('@apollo/gateway');
const { expressMiddleware } = require('@apollo/server/express4');
const { fieldAnalyticsPlugin, getFieldStats } = require('../observability/fieldAnalytics');
const express = require('express');
const cors = require('cors');
const opentelemetry = require('@opentelemetry/api');
const { context, propagation, trace } = require('@opentelemetry/api');

const PORT = process.env.PORT || 4000;

// ── Custom DataSource: propagates OTel trace context to subgraphs ──
// This is how Netflix achieves end-to-end distributed tracing across
// the gateway → subgraph boundary.
class TracingDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context: ctx }) {
    // Propagate W3C traceparent / tracestate to subgraph
    const activeCtx = opentelemetry.context.active();
    const carrier = {};
    propagation.inject(activeCtx, carrier);
    for (const [key, value] of Object.entries(carrier)) {
      request.http.headers.set(key, value);
    }

    // Forward client identity (for field analytics + auth)
    if (ctx.clientName) {
      request.http.headers.set('x-client-name', ctx.clientName);
    }
    if (ctx.userId) {
      request.http.headers.set('x-user-id', ctx.userId);
    }

    // Span per subgraph call
    const subgraphName = this.url?.split(':').pop()?.replace('/graphql', '') || 'unknown';
    const span = tracer.startSpan(`gateway.subgraph.request`, {
      attributes: {
        'subgraph.url': this.url,
        'client.name': ctx.clientName || 'unknown',
      },
    });
    ctx._subgraphSpan = span;
  }

  didReceiveResponse({ response, context: ctx }) {
    ctx._subgraphSpan?.end();
    return response;
  }
}

// ── Gateway config ─────────────────────────────────────────────────
const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      { name: 'users',   url: process.env.USERS_URL   || 'http://localhost:4001/graphql' },
      { name: 'content', url: process.env.CONTENT_URL || 'http://localhost:4002/graphql' },
      { name: 'billing', url: process.env.BILLING_URL || 'http://localhost:4003/graphql' },
    ],
    pollIntervalInMs: 10000, // Re-compose schema every 10s (hot schema updates)
  }),
  buildService({ url }) {
    return new TracingDataSource({ url });
  },
});

// ── Gateway-level request tracing plugin ──────────────────────────
function gatewayTracingPlugin() {
  return {
    async requestDidStart(reqCtx) {
      const operationName = reqCtx.request.operationName || 'anonymous';
      const clientName = reqCtx.request.http?.headers?.get('x-client-name') || 'unknown';

      const span = tracer.startSpan('graphql.request', {
        attributes: {
          'graphql.operation.name': operationName,
          'client.name': clientName,
          'graphql.query': reqCtx.request.query?.slice(0, 200) || '',
        },
      });

      const ctx = trace.setSpan(opentelemetry.context.active(), span);

      return {
        async didEncounterErrors({ errors }) {
          for (const err of errors) {
            span.recordException(err);
          }
          span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
        },

        async willSendResponse({ response }) {
          const extensions = response.body?.singleResult?.extensions;
          if (extensions?.tracing) {
            span.setAttribute('graphql.duration_ms', extensions.tracing.duration / 1e6);
          }
          span.end();
        },
      };
    },
  };
}

// ── Express app ───────────────────────────────────────────────────
async function start() {
  const server = new ApolloServer({
    gateway,
    plugins: [gatewayTracingPlugin(), fieldAnalyticsPlugin()],
    introspection: true,
  });

  await server.start();

  const app = express();
  app.use(cors({ origin: '*', exposedHeaders: ['x-trace-id'] }));
  app.use(express.json({ limit: '1mb' }));

  // Health + readiness
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', service: 'graphql-gateway', port: PORT });
  });

  // ── Field Analytics REST endpoint ─────────────────────────────
  // Netflix uses this pattern: a separate analytics endpoint that product
  // teams query to see field usage before deprecating anything.
  app.get('/analytics/fields', (_, res) => {
    const stats = getFieldStats();
    res.json({
      timestamp: new Date().toISOString(),
      totalFields: stats.length,
      fields: stats,
      summary: {
        totalCalls: stats.reduce((s, f) => s + f.calls, 0),
        deprecationCandidates: stats.filter(f => f.deprecationCandidate).map(f => f.field),
        topFields: stats.slice(0, 5).map(f => ({ field: f.field, calls: f.calls })),
        errorProne: stats.filter(f => parseFloat(f.errorRate) > 5).map(f => ({ field: f.field, errorRate: f.errorRate })),
      },
    });
  });

  // ── Subgraph health aggregation ───────────────────────────────
  app.get('/health/subgraphs', async (_, res) => {
    const subgraphs = [
      { name: 'users',   url: process.env.USERS_URL   || 'http://localhost:4001' },
      { name: 'content', url: process.env.CONTENT_URL || 'http://localhost:4002' },
      { name: 'billing', url: process.env.BILLING_URL || 'http://localhost:4003' },
    ];

    const checks = await Promise.allSettled(
      subgraphs.map(async sg => {
        const baseUrl = sg.url.replace('/graphql', '');
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        const data = await res.json();
        return { ...sg, status: 'healthy', data };
      })
    );

    const results = checks.map((r, i) => ({
      name: subgraphs[i].name,
      status: r.status === 'fulfilled' ? 'healthy' : 'unhealthy',
      error: r.status === 'rejected' ? r.reason?.message : null,
    }));

    res.json({
      gateway: 'healthy',
      subgraphs: results,
      allHealthy: results.every(r => r.status === 'healthy'),
    });
  });

  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req }) => ({
        clientName: req.headers['x-client-name'] || 'web',
        userId: req.headers['x-user-id'] || null,
        // In production: validate JWT here, extract userId, attach to context
        // Netflix moves auth to domain services but keeps AuthN at the gateway
      }),
    })
  );

  app.listen(PORT, () => {
    console.log(`\n🚀 GraphQL Gateway running at http://localhost:${PORT}/graphql`);
    console.log(`📊 Field analytics:       http://localhost:${PORT}/analytics/fields`);
    console.log(`🏥 Subgraph health:        http://localhost:${PORT}/health/subgraphs`);
    console.log(`\n   Subgraphs:`);
    console.log(`   ├── users   → http://localhost:4001/graphql`);
    console.log(`   ├── content → http://localhost:4002/graphql`);
    console.log(`   └── billing → http://localhost:4003/graphql`);
    console.log(`\n   Observability:`);
    console.log(`   └── Jaeger UI → http://localhost:16686\n`);
  });
}

start().catch(console.error);
