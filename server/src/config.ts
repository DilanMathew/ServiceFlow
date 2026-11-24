import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool.default('false'),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 32 bytes hex (64 chars)'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().default(1),
  LOG_LEVEL: z.string().default('info'),
  RUN_WORKER: bool.default('true'),
  // Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  // Email (platform transactional: verification, password reset)
  EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('NEXUS ServiceFlow <no-reply@serviceflow.local>'),
  // AI
  AI_PROVIDER: z.enum(['rules', 'anthropic']).default('rules'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  // Maps
  MAPS_PROVIDER: z.enum(['none', 'google', 'osm']).default('osm'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // NEXUS SaaS billing gateway
  BILLING_PROVIDER: z.enum(['manual', 'test', 'stripe', 'razorpay']).default('manual'),
  BILLING_KEY_ID: z.string().optional(),
  BILLING_SECRET_KEY: z.string().optional(),
  BILLING_WEBHOOK_SECRET: z.string().optional(),
  BILLING_GRACE_DAYS: z.coerce.number().default(7),
  // Error monitoring
  SENTRY_DSN: z.string().optional(),
  SEED_DEMO: bool.default('false'),
  PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
