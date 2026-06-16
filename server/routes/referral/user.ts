// Identity handling for stored data.
//
// A care-need query tied to an email is health data. We never store the raw
// email — instead a salted SHA-256 pseudonym, which still lets per-user features
// (shortlists) work (same user → same id) without persisting PII.
import { createHash } from 'node:crypto';
import { Request } from 'express';

const SALT = process.env.APP_USER_SALT ?? 'referral-copilot-dev-salt';

export function userId(req: Request): string {
  const email = req.header('x-forwarded-email') ?? 'local-dev';
  return 'u_' + createHash('sha256').update(`${SALT}:${email}`).digest('hex').slice(0, 32);
}
