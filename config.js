const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(18000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  GMAIL_USER: z.string().trim().default(''),
  GMAIL_APP_PASSWORD: z.string().trim().default(''),
  gmailUser: z.string().trim().default(''),
  gmailAppSpecificPassword: z.string().trim().default(''),
  gmailSendserver: z.string().trim().default('smtp.gmail.com'),
  gmailPort: z.coerce.number().int().min(1).max(65535).default(587),
  EMAIL_FROM_NAME: z.string().trim().min(1).max(100).default('AVSEC'),
  PASSWORD_RESET_OTP_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(100).max(10000).default(1000),
  API_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  PUBLIC_APP_API_KEYS: z.string().default('').refine(
    (value) => value === '' || value.split(',').every((key) => key.trim().length >= 32),
    'Every public application API key must contain at least 32 characters.'
  )
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration: ${fields}`);
}

module.exports = {
  ...result.data,
  GMAIL_USER: result.data.GMAIL_USER || result.data.gmailUser,
  GMAIL_APP_PASSWORD: (
    result.data.GMAIL_APP_PASSWORD || result.data.gmailAppSpecificPassword
  ).replace(/\s/g, ''),
  GMAIL_SMTP_HOST: result.data.gmailSendserver,
  GMAIL_SMTP_PORT: result.data.gmailPort,
  CORS_ALLOWED_ORIGINS: result.data.CORS_ALLOWED_ORIGINS
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  PUBLIC_APP_API_KEYS: result.data.PUBLIC_APP_API_KEYS
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
};
