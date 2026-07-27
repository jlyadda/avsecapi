const express = require('express');
const cors = require('cors');
const config = require('./config');
const authRoutes = require('./routes/auth');
const visitorRoutes = require('./routes/visitors');
const userRoutes = require('./routes/users');
const applicationRoutes = require('./routes/applications');
const apiKeyRoutes = require('./routes/apiKeys');
const vehicleApplicationRoutes = require('./routes/vehicleApplications');
const accountRoutes = require('./routes/account');
const accessCardRoutes = require('./routes/accessCards');
const passwordResetRoutes = require('./routes/passwordReset');
const { apiLimiter } = require('./rateLimits');

const app = express();
const allowedOrigins = new Set(config.CORS_ALLOWED_ORIGINS);

app.disable('x-powered-by');
if (config.TRUST_PROXY_HOPS > 0) app.set('trust proxy', config.TRUST_PROXY_HOPS);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.has(origin.replace(/\/$/, '')));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
  credentials: true,
  maxAge: 600,
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(
  '/api',
  apiLimiter,
  authRoutes,
  apiKeyRoutes,
  applicationRoutes,
  vehicleApplicationRoutes,
  accountRoutes,
  accessCardRoutes,
  passwordResetRoutes,
  visitorRoutes,
  userRoutes
);

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(error);
  return res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;
