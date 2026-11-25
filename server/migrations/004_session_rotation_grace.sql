-- When the refresh token was last rotated. A rotated-out token presented shortly after rotation is a
-- lost response (page reloaded mid-refresh), not theft; see the reuse grace window in auth/routes.ts.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
