import { config } from '../config.js';
import type { TenantIntegration } from './registry.js';

export interface LatLng { lat: number; lng: number }

export function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Travel estimate. Google Distance Matrix when configured; otherwise straight-line x 1.4 at 25 km/h urban average. */
export async function travelEstimate(from: LatLng, to: LatLng, integration?: TenantIntegration | null): Promise<{ km: number; minutes: number; source: string }> {
  const key = integration?.provider === 'google' ? integration.secrets.apiKey : config.GOOGLE_MAPS_API_KEY;
  if (key && (integration?.provider === 'google' || config.MAPS_PROVIDER === 'google')) {
    try {
      const u = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
      u.searchParams.set('origins', `${from.lat},${from.lng}`); u.searchParams.set('destinations', `${to.lat},${to.lng}`); u.searchParams.set('key', key);
      const j: any = await (await fetch(u, { signal: AbortSignal.timeout(8000) })).json();
      const el = j.rows?.[0]?.elements?.[0];
      if (el?.status === 'OK') return { km: el.distance.value / 1000, minutes: Math.round(el.duration.value / 60), source: 'google' };
    } catch { /* fall through to estimate */ }
  }
  const km = haversineKm(from, to) * 1.4;
  return { km: Math.round(km * 10) / 10, minutes: Math.round((km / 25) * 60), source: 'estimate' };
}

export async function geocode(address: string, integration?: TenantIntegration | null): Promise<LatLng | null> {
  try {
    const key = integration?.provider === 'google' ? integration.secrets.apiKey : config.GOOGLE_MAPS_API_KEY;
    if (key && (integration?.provider === 'google' || config.MAPS_PROVIDER === 'google')) {
      const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      u.searchParams.set('address', address); u.searchParams.set('key', key);
      const j: any = await (await fetch(u, { signal: AbortSignal.timeout(8000) })).json();
      const loc = j.results?.[0]?.geometry?.location;
      return loc ? { lat: loc.lat, lng: loc.lng } : null;
    }
    if (config.MAPS_PROVIDER === 'osm') {
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.searchParams.set('q', address); u.searchParams.set('format', 'json'); u.searchParams.set('limit', '1');
      const j: any = await (await fetch(u, { headers: { 'User-Agent': 'ServiceFlow/1.0' }, signal: AbortSignal.timeout(8000) })).json();
      return j?.[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
    }
  } catch { /* geocoding is best-effort */ }
  return null;
}

export const mapsLink = (a: { latitude?: any; longitude?: any; line1?: string; city?: string; postal_code?: string }) =>
  a.latitude && a.longitude
    ? `https://www.google.com/maps/dir/?api=1&destination=${a.latitude},${a.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([a.line1, a.city, a.postal_code].filter(Boolean).join(', '))}`;
