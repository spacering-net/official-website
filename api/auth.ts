import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { audit } from './audit';
import { keepAvatar } from './avatars';
import { later } from './context';
import { uuidv7 } from './ids';
import { nextRingNumber } from './ring-number';

/** Better Auth's field names, as this database's snake_case columns (see db/migrations). */
const STAMPS = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;

const localeOf = (headers?: Headers) => (/^zh\b/i.test(headers?.get('accept-language') ?? '') ? 'zh-CN' : 'en');

/**
 * Sign-in is all GitHub and Google are used for, so the tokens they issue are
 * not kept (a feature that needs one will ask for it, and store it encrypted).
 */
const withoutTokens = <T extends Record<string, unknown>>(account: T) => ({
  ...account,
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
});

export function authOptions(env: Env) {
  return {
    appName: 'SpaceRing',
    baseURL: env.SITE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.SITE_URL],
    telemetry: { enabled: false },
    socialProviders: {
      // read:user and user:email by default; the primary address counts only if GitHub verified it
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account' },
    },
    user: {
      modelName: 'users',
      fields: { emailVerified: 'email_verified', ...STAMPS },
      additionalFields: {
        // The ring number engraved on the band, and the language the user
        // signed up in. Both set here, never by the client.
        number: { type: 'number', required: false, input: false },
        locale: { type: 'string', required: false, input: false },
      },
    },
    session: {
      modelName: 'sessions',
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', ...STAMPS },
      // a month, renewed at most once a day while in use
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // No cookie cache: every check reads the database, so signing out or
      // revoking a session takes effect at once, even if a stale cookie comes
      // back. The cost is one small read per signed-in page load.
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        ...STAMPS,
      },
      // not kept at all (withoutTokens); encrypted if a later feature keeps one
      encryptOAuthTokens: true,
      // A second provider joins an existing user only when both have verified
      // the same email; otherwise it becomes a user of its own.
      accountLinking: { enabled: true },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', ...STAMPS },
    },
    advanced: {
      cookiePrefix: 'sr',
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      backgroundTasks: { handler: later },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => ({
            data: { ...user, number: await nextRingNumber(env.DB), locale: localeOf(ctx?.headers ?? ctx?.request?.headers) },
          }),
          after: async (user, ctx) => later(audit(env, 'user.created', user.id, { number: user.number }, ctx?.request)),
        },
      },
      session: {
        create: {
          after: async (session, ctx) => {
            // the provider's picture, copied to R2 (avatars.ts); after a failed copy the next sign-in tries again
            later(keepAvatar(env, session.userId));
            later(audit(env, 'session.created', session.userId, undefined, ctx?.request));
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({ data: withoutTokens(account) }),
          after: async (account, ctx) => later(audit(env, 'account.linked', account.userId, { provider: account.providerId }, ctx?.request)),
        },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
    },
  } satisfies BetterAuthOptions;
}

const createAuth = (env: Env) => betterAuth(authOptions(env));
let cached: { env: Env; auth: ReturnType<typeof createAuth> } | undefined;

/**
 * One instance per isolate: setting Better Auth up checks the database schema,
 * which is worth doing once, not on every request.
 */
export function getAuth(env: Env) {
  if (cached?.env !== env) cached = { env, auth: createAuth(env) };
  return cached.auth;
}
