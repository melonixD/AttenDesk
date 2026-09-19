import { createDatabase } from '../src/db.js';
import { hashPassword, passwordProblem } from '../src/security.js';
const email = String(process.env.RESET_EMAIL || '').trim().toLowerCase();
const password = process.env.RESET_PASSWORD;
if (!email || passwordProblem(password)) throw new Error('Set RESET_EMAIL and RESET_PASSWORD (8+ characters, letters and numbers) in your private environment.');
const db = createDatabase();
try {
  await db.transaction(async client => {
    const found = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) FOR UPDATE', [email]);
    if (found.rowCount !== 1) throw new Error('Expected exactly one account for this email; no account changed.');
    await client.query('UPDATE users SET password_hash=$1,password_set_at=now() WHERE id=$2', [hashPassword(password), found.rows[0].id]);
    await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1', [found.rows[0].id]);
  });
  console.log('Password reset. Remove RESET_PASSWORD from your environment and sign in with your email.');
} finally { await db.close(); }
