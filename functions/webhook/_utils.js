// -----------------------------------------------------------------------------
// Shared helpers for webhook adapters.
//
// The webhook URL shape is `/webhook/<platform>/<slug>`, where `<slug>` is a
// 36-character UUID v4 (122 bits of entropy) generated per recipient during
// `deploy-stack` and stored as a Cloudflare secret. The adapter receives the
// slug via `context.params.slug` and compares it to the env var.
//
// This is obscure-URL authentication: unguessable to scanners, simple for
// non-dev recipients (no signing-secret pastes per platform). Platform-native
// signature verification (HMAC/hottok) is deliberately deferred to a
// post-launch `harden-tracking` Level 2 skill.
// -----------------------------------------------------------------------------

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Guards a webhook adapter on the per-platform URL slug.
//
// Returns a Response on failure (caller should return it directly):
//   - 500 if the env var is unset — a misconfigured deploy that should NOT
//     silently accept traffic
//   - 404 if the slug is missing or wrong — indistinguishable from the
//     route not existing, so scanners learn nothing
//
// Returns null on success (caller proceeds to read body + parse payload).
export function guardSlug(paramSlug, expectedSlug) {
  if (!expectedSlug) {
    return new Response(
      JSON.stringify({ error: 'webhook not configured on this instance' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (!paramSlug || !timingSafeEqual(paramSlug, expectedSlug)) {
    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}
