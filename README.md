# Netflix-Inspired Federated GraphQL Gateway

A production-quality implementation of a federated GraphQL supergraph with distributed
tracing and field-level analytics — directly inspired by Netflix's Studio Edge architecture
and their 2024–2025 engineering blog posts.

---

## What This Implements

| Netflix Pattern | This Project |
|---|---|
| Domain Graph Services (DGS) per team | 3 independent subgraphs: users, content, billing |
| Apollo Federation v2 supergraph | Gateway composes all subgraphs at runtime |
| Zipkin/OTel distributed tracing | OpenTelemetry → OTLP → Jaeger, trace context propagated across subgraph boundaries |
| Field-level analytics for deprecation | Custom Apollo plugin records per-field calls, latency, error rate, and client identity |
| Authorization at the gateway | `x-user-id` forwarded to subgraphs; auth logic owned by domain services |
| Schema hot-reload | `IntrospectAndCompose` polls subgraphs every 10s — schema changes without restart |

---

## Architecture

```
Client
  │  x-client-name, x-user-id headers
  ▼
┌─────────────────────────────────────┐
│         GraphQL Gateway :4000       │  ← OTel root span per request
│  • Schema composition               │
│  • Auth context forwarding          │
│  • Trace context propagation        │
│  • Field analytics aggregation      │
└────┬──────────┬───────────┬─────────┘
     │          │           │
     ▼          ▼           ▼
  users      content     billing
  :4001       :4002       :4003
  
  User        Title       Subscription
  Profile     WatchEntry  Invoice
              (extends    (extends
               User)       User)

     All services → OTLP HTTP → Jaeger :16686
```

### Federation Entity Relationships

```graphql
# users-subgraph owns User
type User @key(fields: "id") {
  id: ID!
  name: String!
  profiles: [Profile!]!
}

# content-subgraph EXTENDS User
type User @key(fields: "id") @extends {
  id: ID! @external
  watchHistory: [WatchEntry!]!     # ← content team owns this
  recommendations: [Title!]!
}

# billing-subgraph EXTENDS User
type User @key(fields: "id") @extends {
  id: ID! @external
  subscription: Subscription       # ← billing team owns this
  billingHealth: BillingHealth!
}
```

A single client query like `user { name watchHistory { title } subscription { plan } }`
is automatically **query-planned** by the gateway, dispatched to 3 subgraphs in parallel,
and stitched into one response.

---

## Quick Start

### Option 1 — Docker (recommended)

```bash
git clone <repo>
cd netflix-graphql-gateway

# Start Jaeger + all 4 services in one command
npm run docker:up

# Services:
#   GraphQL Gateway    → http://localhost:4000/graphql
#   Analytics Dashboard→ http://localhost:3000
#   Jaeger UI          → http://localhost:16686
```

### Option 2 — Local dev (requires Node 20+)

```bash
npm install          # installs all workspace deps

# Terminal 1 — Users subgraph
cd subgraphs/users && npm run dev

# Terminal 2 — Content subgraph
cd subgraphs/content && npm run dev

# Terminal 3 — Billing subgraph
cd subgraphs/billing && npm run dev

# Terminal 4 — Gateway (start AFTER subgraphs are ready)
cd gateway && npm run dev

# Terminal 5 — Dashboard
cd dashboard && npm run dev
```

Or use the convenience script:
```bash
npm run dev   # concurrently starts all 5 services with color-coded output
```

---

## Example Queries

### Cross-domain query (the killer feature of federation)

```graphql
query GetMemberDashboard {
  user(id: "u1") {
    name
    email
    plan

    # Resolved by content-subgraph
    watchHistory {
      title { title genre rating }
      progressPercent
    }
    recommendations { id title genre }

    # Resolved by billing-subgraph
    subscription { plan status priceUsd nextBillingDate }
    billingHealth { isHealthy issues }
  }
}
```

**One query → gateway query-plans → 3 subgraphs → merged response.**
The client has zero knowledge of the underlying services.

### Content browsing

```graphql
query {
  trending { id title rating genre type }
  titles(genre: DRAMA, type: SERIES) { title year rating }
  search(query: "strange") { title description }
}
```

---

## Field-Level Analytics

The `GET /analytics/fields` endpoint returns:

```json
{
  "timestamp": "2025-05-25T...",
  "totalFields": 34,
  "fields": [
    {
      "field": "Query.user",
      "calls": 142,
      "errors": 0,
      "errorRate": "0%",
      "avgLatencyMs": 3,
      "clients": ["web", "mobile", "dashboard"],
      "deprecationCandidate": false
    },
    {
      "field": "User.legacyPreferences",
      "calls": 2,
      "errors": 0,
      "clients": [],
      "deprecationCandidate": true    ← safe to deprecate
    }
  ],
  "summary": {
    "deprecationCandidates": ["User.legacyPreferences"],
    "errorProne": []
  }
}
```

This is how Netflix's teams **safely deprecate schema fields** — they can see exactly
which clients are using a field before removing it.

---

## Distributed Tracing

Every request produces an end-to-end trace:

```
Gateway request span
  ├── graphql.field Query.user (3ms)
  ├── gateway.subgraph.request → users-subgraph
  │     └── resolver.me (2ms)
  ├── gateway.subgraph.request → content-subgraph
  │     ├── resolver.user.watchHistory (5ms)
  │     └── resolver.user.recommendations (12ms)
  └── gateway.subgraph.request → billing-subgraph
        └── resolver.user.subscription (4ms)
```

View traces at: **http://localhost:16686** (Jaeger UI)

Trace context propagates via **W3C `traceparent` header** — the same standard Netflix
adopted via OpenTelemetry with the Zipkin data model.

---

## Production Hardening (next steps)

These are the gaps between this project and Netflix-scale production:

1. **Schema Registry** — replace `IntrospectAndCompose` with a schema registry (Apollo GraphOS or custom). Subgraphs register their SDL; the gateway pulls composed schema without polling.
2. **Auth** — Implement JWT validation at the gateway. Extract `userId` from the token and forward as a trusted header (never trust client-provided `x-user-id` in production).
3. **DataLoader** — Add DataLoader batching to subgraph resolvers to eliminate N+1 queries (critical for `watchHistory` over many users).
4. **Persistent analytics** — Flush `fieldStats` to ClickHouse/BigQuery on a timer for long-term retention and dashboarding.
5. **Rate limiting** — Add query complexity scoring at the gateway to prevent expensive queries from overloading subgraphs.
6. **Schema linting** — Enforce breaking change detection in CI (Apollo Rover CLI).

---

## Tech Stack

- **Apollo Federation v2** — supergraph composition
- **Apollo Server v4** — subgraph and gateway runtime
- **OpenTelemetry (OTel)** — tracing SDK, OTLP HTTP exporter
- **Jaeger** — trace backend (Zipkin-compatible, as Netflix uses)
- **Express** — HTTP server for each service
- **Node.js 20** — native `fetch`, virtual module support
- **Docker Compose** — local orchestration

---

## References

- [Netflix: An Unexpected Journey to Federated Supergraph](https://www.apollographql.com/blog/an-unexpected-journey-how-netflix-transitioned-to-a-federated-supergraph) (Apollo Blog)
- [Netflix GraphQL Federation Blueprint](https://medium.com/@simardeep.oberoi/graphql-federation-at-scale-the-netflix-engineering-blueprint-85358b653e52)
- [Netflix Observability: From Confusion to Clarity](https://www.infoq.com/presentations/stream-pipeline-observability/) (InfoQ)
- [OpenTelemetry in Apollo Federation](https://www.apollographql.com/docs/graphos/routing/observability/router-telemetry-otel/enabling-telemetry/usage-guides/subgraph-instrumentation) (Apollo Docs)
- [Netflix DGS Framework](https://netflix.github.io/dgs/)
