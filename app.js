const express = require('express');
const config = require('./config');
const authRoutes = require('./routes/auth');
const visitorRoutes = require('./routes/visitors');
const userRoutes = require('./routes/users');
const applicationRoutes = require('./routes/applications');
const apiKeyRoutes = require('./routes/apiKeys');
const { apiLimiter } = require('./rateLimits');

const app = express();

app.disable('x-powered-by');
if (config.TRUST_PROXY_HOPS > 0) app.set('trust proxy', config.TRUST_PROXY_HOPS);

app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', apiLimiter, authRoutes, apiKeyRoutes, applicationRoutes, visitorRoutes, userRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(error);
  return res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;
