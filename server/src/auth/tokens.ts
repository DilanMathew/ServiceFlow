import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AccessClaims {
  sub: string;        // user id
  sid: string;        // session id
  tid: string | null; // tenant id
  typ: 'platform' | 'staff' | 'customer' | 'support';
}

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: `${config.ACCESS_TOKEN_TTL_MIN}m`, issuer: 'serviceflow', audience: 'serviceflow-api' });
}
export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: 'serviceflow', audience: 'serviceflow-api' }) as AccessClaims;
}
