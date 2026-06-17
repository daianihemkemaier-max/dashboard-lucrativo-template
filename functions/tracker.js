export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const userAgent = request.headers.get('user-agent') || '';
    const cookies = parseCookies(request.headers.get('Cookie') || '');

    // Session lookup for UTM enrichment
    const sessionId = cookies['_krob_sid'] || '';
    if (sessionId && env.DB) {
      try {
        await env.DB.prepare('SELECT session_id FROM sessions WHERE session_id = ?')
          .bind(sessionId).first();
      } catch (e) {
        console.error('D1 session lookup error:', e.message);
      }
    }

    const { isBot, botReason } = detectBot(userAgent);
    const browserInfo = parseBrowser(userAgent);

    context.waitUntil(
      (async () => {
        try {
          if (env.DB) {
            await env.DB.prepare(`
              INSERT INTO event_log (
                session_id, event_name, event_id, timestamp,
                browser, browser_version, os, is_mobile,
                pixel_was_blocked, fbp_source, fbc_source, fbclid_source,
                ga_cookie_present, ga_client_id_fallback, itp_cookie_extended,
                is_bot, bot_reason, consent_status,
                sent_to_meta, meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
                sent_to_ga4, ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
                has_email, has_phone, has_name,
                raw_email
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              sessionId, body.event_name, body.event_id, body.event_time,
              browserInfo.browser, browserInfo.version, browserInfo.os, browserInfo.isMobile ? 1 : 0,
              0, 'none', 'none', 'none',
              0, 0, 0,
              isBot ? 1 : 0, botReason, body.consent_status || 'unknown',
              0, 0, 0, '', null,
              0, 0, 0, '', null,
              0, 0, 0,
              ''
            ).run();
          }
        } catch (e) {
          console.error('D1 log error:', e.message);
        }
      })()
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}

function detectBot(userAgent) {
  if (!userAgent || userAgent.length < 10) {
    return { isBot: true, botReason: 'Missing or short user-agent' };
  }
  const patterns = [
    { p: /googlebot|google-inspectiontool/i, r: 'Googlebot' },
    { p: /bingbot|msnbot/i, r: 'Bingbot' },
    { p: /facebookexternalhit|facebot/i, r: 'Facebook crawler' },
    { p: /twitterbot/i, r: 'Twitter crawler' },
    { p: /linkedinbot/i, r: 'LinkedIn crawler' },
    { p: /slackbot/i, r: 'Slackbot' },
    { p: /whatsapp/i, r: 'WhatsApp preview' },
    { p: /bot|crawler|spider|scraper|headless/i, r: 'Generic bot' },
    { p: /python-requests|axios|node-fetch|curl|wget|httpie/i, r: 'HTTP library' },
    { p: /phantomjs|selenium|puppeteer|playwright/i, r: 'Automation tool' },
  ];
  for (const { p, r } of patterns) {
    if (p.test(userAgent)) return { isBot: true, botReason: r };
  }
  return { isBot: false, botReason: '' };
}

function parseBrowser(ua) {
  const r = { browser: 'Unknown', version: '', os: 'Unknown', isMobile: false };
  if (!ua) return r;
  r.isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  if (/Edg\//i.test(ua))       { r.browser = 'Edge';    r.version = ua.match(/Edg\/([\d.]+)/)?.[1]     || ''; }
  else if (/OPR\//i.test(ua))  { r.browser = 'Opera';   r.version = ua.match(/OPR\/([\d.]+)/)?.[1]     || ''; }
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) { r.browser = 'Chrome'; r.version = ua.match(/Chrome\/([\d.]+)/)?.[1] || ''; }
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua))   { r.browser = 'Safari'; r.version = ua.match(/Version\/([\d.]+)/)?.[1] || ''; }
  else if (/Firefox\//i.test(ua)) { r.browser = 'Firefox'; r.version = ua.match(/Firefox\/([\d.]+)/)?.[1] || ''; }
  if      (/Windows/i.test(ua))  r.os = 'Windows';
  else if (/Mac OS X/i.test(ua)) r.os = 'macOS';
  else if (/iPhone|iPad/i.test(ua)) r.os = 'iOS';
  else if (/Android/i.test(ua))  r.os = 'Android';
  else if (/Linux/i.test(ua))    r.os = 'Linux';
  return r;
}
