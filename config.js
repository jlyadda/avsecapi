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
  PUBLIC_APP_API_KEYS: result.data.PUBLIC_APP_API_KEYS
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
};
