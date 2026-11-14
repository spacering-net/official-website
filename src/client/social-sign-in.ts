/** Provider tokens and website cookies stay on SRN; clients use a separate grant. */
export async function socialSignIn(provider: string, callbackURL: string, errorCallbackURL = callbackURL): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, callbackURL, errorCallbackURL }),
    });
    const data = (await res.json().catch(() => null)) as { url?: string } | null;
    if (res.ok && data?.url) { location.assign(data.url); return true; }
  } catch { /* the caller displays a retryable error */ }
  return false;
}
