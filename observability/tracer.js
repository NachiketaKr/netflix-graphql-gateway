/**
 * observability/tracer.js
 *
 * Shared OpenTelemetry setup — inspired by Netflix's adoption of OTel
 * with Zipkin data model (client spans, server spans).
 *
 * Each service calls initTracer(serviceName) before anything else.
 * Traces are exported to Jaeger (OTLP HTTP) running in Docker.
 */

'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
const { SimpleSpanProcessor, ConsoleSpanExporter, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const opentelemetry = require('@opentelemetry/api');

let sdk = null;

function initTracer(serviceName, serviceVersion = '1.0.0') {
  const otlpEndpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4318';

  const exporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: {},
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
      'deployment.environment': process.env.NODE_ENV || 'development',
      'team': 'platform-api',
    }),
    spanProcessor: process.env.NODE_ENV === 'production'
      ? new BatchSpanProcessor(exporter)
      : new SimpleSpanProcessor(exporter),
    textMapPropagator: new W3CTraceContextPropagator(),
  });

  sdk.start();

  process.on('SIGTERM', () => sdk.shutdown());
  process.on('SIGINT', () => sdk.shutdown());

  console.log(`[OTel] Tracer initialized for service: ${serviceName} → ${otlpEndpoint}`);
  return opentelemetry.trace.getTracer(serviceName, serviceVersion);
}

function getTracer(name = 'default') {
  return opentelemetry.trace.getTracer(name);
}

function startSpan(tracer, name, attributes = {}, parentContext = null) {
  const ctx = parentContext || opentelemetry.context.active();
  const span = tracer.startSpan(name, { attributes }, ctx);
  return { span, ctx: opentelemetry.trace.setSpan(ctx, span) };
}

function endSpan(span, error = null) {
  if (error) {
    span.recordException(error);
    span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
  }
  span.end();
}

module.exports = { initTracer, getTracer, startSpan, endSpan };
