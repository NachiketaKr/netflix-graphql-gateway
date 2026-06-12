/**
 * dashboard/server.js
 * Lightweight Express server that serves the analytics dashboard HTML
 * and proxies requests to the gateway's analytics endpoints.
 */
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy field analytics from gateway
app.get('/api/analytics/fields', async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY_URL}/analytics/fields`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'Gateway unavailable', message: e.message });
  }
});

// Proxy subgraph health
app.get('/api/health/subgraphs', async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY_URL}/health/subgraphs`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'Gateway unavailable', message: e.message });
  }
});

// Proxy GraphQL queries to gateway (for the playground in dashboard)
app.post('/api/graphql', express.json(), async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY_URL}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-name': req.headers['x-client-name'] || 'dashboard',
      },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ errors: [{ message: 'Gateway unavailable: ' + e.message }] });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ Analytics dashboard running at http://localhost:${PORT}`);
});
