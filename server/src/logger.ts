import { pino } from 'pino';
import { config } from './config.js';

// Never log secrets / personal data: these paths are redacted everywhere.
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.passwordHash', '*.password_hash', '*.token', '*.refreshToken', '*.secret',
      '*.secrets', '*.apiKey', '*.api_key', '*.mfaCode', '*.cardNumber',
    ],
    censor: '[REDACTED]',
  },
});
