-- Separate opt-in permission: existing metrics viewers are not granted API access.
ALTER TYPE "UserScope" ADD VALUE IF NOT EXISTS 'api_metrics.view';
