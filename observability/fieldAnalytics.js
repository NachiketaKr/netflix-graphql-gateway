/**
 * observability/fieldAnalytics.js
 *
 * Field-Level Analytics — inspired by Netflix's approach where
 * "usage analytics support deprecation workflows by showing exactly
 * which clients use specific fields" (Netflix Engineering Blog, 2025).
 *
 * This plugin hooks into Apollo's execution to record:
 *  - Which fields were requested
 *  - Which client requested them (via x-client-name header)
 *  - Latency per field resolver
 *  - Error rate per field
 *
 * Data is stored in-memory (swap for Redis/ClickHouse in production).
 */

'use strict';

const opentelemetry = require('@opentelemetry/api');

// In-memory store — in production, flush to ClickHouse / BigQuery
const fieldStats = new Map();
// { "TypeName.fieldName": { calls, errors, totalLatencyMs, clients: Set } }

function recordField(typeName, fieldName, clientName, latencyMs, isError = false) {
  const key = `${typeName}.${fieldName}`;
  if (!fieldStats.has(key)) {
    fieldStats.set(key, { calls: 0, errors: 0, totalLatencyMs: 0, clients: new Set() });
  }
  const stat = fieldStats.get(key);
  stat.calls++;
  stat.totalLatencyMs += latencyMs;
  if (isError) stat.errors++;
  if (clientName) stat.clients.add(clientName);
}

function getFieldStats() {
  const result = [];
  for (const [field, stat] of fieldStats.entries()) {
    result.push({
      field,
      calls: stat.calls,
      errors: stat.errors,
      errorRate: stat.calls > 0 ? ((stat.errors / stat.calls) * 100).toFixed(1) + '%' : '0%',
      avgLatencyMs: stat.calls > 0 ? Math.round(stat.totalLatencyMs / stat.calls) : 0,
      clients: Array.from(stat.clients),
      // Flag fields with zero recent usage — candidates for deprecation
      deprecationCandidate: stat.calls < 5 && stat.clients.size === 0,
    });
  }
  return result.sort((a, b) => b.calls - a.calls);
}

function resetStats() {
  fieldStats.clear();
}

/**
 * Apollo Server plugin that instruments every field resolver.
 * Attach to ApolloServer({ plugins: [fieldAnalyticsPlugin()] })
 */
function fieldAnalyticsPlugin() {
  return {
    async requestDidStart(requestContext) {
      const clientName = requestContext.request.http?.headers?.get('x-client-name') || 'unknown';
      const operationName = requestContext.request.operationName || 'anonymous';
      const tracer = opentelemetry.trace.getTracer('field-analytics');

      return {
        async executionDidStart() {
          return {
            willResolveField({ info }) {
              const start = Date.now();
              const typeName = info.parentType.name;
              const fieldName = info.fieldName;

              // Create a child OTel span per field
              const parentCtx = opentelemetry.context.active();
              const span = tracer.startSpan(
                `graphql.field ${typeName}.${fieldName}`,
                {
                  attributes: {
                    'graphql.field.name': fieldName,
                    'graphql.field.type': typeName,
                    'graphql.operation.name': operationName,
                    'client.name': clientName,
                  },
                },
                parentCtx
              );

              return (error, result) => {
                const latencyMs = Date.now() - start;
                const isError = !!error;

                recordField(typeName, fieldName, clientName, latencyMs, isError);

                span.setAttributes({
                  'graphql.field.latency_ms': latencyMs,
                  'graphql.field.error': isError,
                });

                if (error) {
                  span.recordException(error);
                  span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
                } else {
                  span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
                }
                span.end();
              };
            },
          };
        },
      };
    },
  };
}

module.exports = { fieldAnalyticsPlugin, getFieldStats, resetStats };
