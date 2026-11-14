import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';

// Writes the SQL for a Codeg client registration (and, for Web, its secret)
// into a new restricted directory. It never touches a database itself.
const USAGE = `Usage:
  Web instance:     node scripts/register-codeg-client.mjs --owner-srn 10000 --public-url https://codeg.example.com --output /secure/new-directory
  Rotate a secret:  node scripts/register-codeg-client.mjs --rotate-client-id codeg-web-… --output /secure/new-directory
  Desktop build:    node scripts/register-codeg-client.mjs --desktop-id codeg-desktop-dev --name "Codeg Dev" --output /secure/new-directory`;
const { values } = parseArgs({ options: {
  'owner-srn': { type: 'string' }, 'public-url': { type: 'string' }, output: { type: 'string' },
  'rotate-client-id': { type: 'string' }, 'desktop-id': { type: 'string' }, name: { type: 'string' },
} });
const rotate = values['rotate-client-id'];
const desktop = values['desktop-id'];
const modes = [rotate, desktop, values['public-url']].filter(Boolean).length;
if (!values.output || modes !== 1 || (values['public-url'] && !values['owner-srn'])) throw new Error(USAGE);
if (rotate && !/^codeg-web-[A-Za-z0-9_-]{16,128}$/.test(rotate)) throw new Error('Invalid client ID');
// The release build is codeg-desktop (migration 0003); other builds get their own ID.
if (desktop && (!/^codeg-desktop-[a-z0-9]{1,24}$/.test(desktop))) throw new Error('A desktop ID is codeg-desktop-<1-24 lowercase letters or digits>');
const name = values.name ?? 'Codeg';
if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw new Error('Invalid display name');
let publicUrl;
if (values['public-url']) {
  publicUrl = new URL(values['public-url']);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.port || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash
    || !publicUrl.hostname.includes('.') || isIP(publicUrl.hostname) || publicUrl.hostname.startsWith('[')) throw new Error('An exclusive HTTPS hostname on the root path and standard port is required');
  if (!/^[1-9][0-9]{4,8}$/.test(values['owner-srn'])) throw new Error('Invalid owner SRN');
}
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 }); // Refuse existing directories and accidental overwrite.
const sqlPath = resolve(output, 'registration.sql');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
if (desktop) {
  // A public client: no secret, loopback redirect on any port.
  await writeFile(sqlPath, `INSERT INTO client_registrations (client_id,client_type,name,redirect_uri,created_at,updated_at)
VALUES (${q(desktop)},'desktop',${q(name)},'http://127.0.0.1/auth/callback',${stamp},${stamp});\n`, { mode: 0o600, flag: 'wx' });
  console.info(`Client ID: ${desktop}\nRegistration SQL: ${sqlPath}\nNo database or deployment has been changed.`);
} else {
  const clientId = rotate ?? `codeg-web-${randomBytes(32).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(secret).digest('hex');
  const secretPath = resolve(output, 'client-secret');
  // An unknown owner SRN yields NULL, which the registration trigger refuses.
  const sql = rotate
    ? `UPDATE client_registrations SET secret_hash = ${q(digest)}, secret_version = secret_version + 1, updated_at = ${stamp} WHERE client_id = ${q(clientId)} AND client_type = 'web';\n`
    : `INSERT INTO client_registrations (client_id,client_type,owner_user_id,name,redirect_uri,secret_hash,created_at,updated_at)
VALUES (${q(clientId)},'web',(SELECT id FROM users WHERE number = ${Number(values['owner-srn'])}),${q(name)},${q(`${publicUrl.origin}/auth/srn/callback`)},${q(digest)},${stamp},${stamp});\n`;
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(sqlPath, sql, { mode: 0o600, flag: 'wx' });
  console.info(`Client ID: ${clientId}\nRegistration SQL: ${sqlPath}\nRestricted secret file: ${secretPath}\nNo database or deployment has been changed.${rotate ? '\nCheck that applying it reports one changed row.' : ''}`);
}
