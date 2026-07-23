// api/contact.js — Vercel Serverless Function für sunny-beach.xyz
// RESEND_API_KEY als Vercel Env-Variable setzen

const ALLOWED_ORIGINS = [
  'https://www.sunny-beach.xyz',
  'https://sunny-beach.xyz',
];

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, 2000);
}

function looksHuman(str) {
  if (!str) return true;
  const noSpace = str.replace(/\s/g, '');
  return noSpace.length <= 60;
}

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 3600000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > 3;
}

// Catches bot-generated random tokens that are short enough to slide past a simple
// length check but look nothing like a real word: very few vowels AND unnaturally
// frequent upper/lowercase switching. Both conditions required together to avoid
// flagging real oddly-cased words (e.g. "McDonald").
// E-Mail-Blockliste — normalisiert Gmail-Punkte/Plus-Tags, damit Bots sie nicht
// durch e.dip.a.ju.l.o.d.ev.8.5@gmail.com vs. ed.ip.ajulo.de.v85@gmail.com umgehen.
const BLOCKED_EMAILS = new Set([
  'ugibanicepi459@gmail.com',
  'edipajulodev85@gmail.com',
]);
function normalizeEmail(email) {
  const e = (email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at === -1) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
  }
  return local + '@' + (domain === 'googlemail.com' ? 'gmail.com' : domain);
}

function isGibberish(str) {
  const words = (str || '').split(/\s+/).filter(w => w.length >= 6);
  const vowelChars = 'aeiouyAEIOUYäöüÄÖÜàáâãåèéêëìíîïòóôõùúûýÀÁÂÃÅÈÉÊËÌÍÎÏÒÓÔÕÙÚÛÝ';
  for (const word of words) {
    const letters = word.replace(/[^a-zA-ZäöüÄÖÜßàáâãåèéêëìíîïòóôõùúûýÀÁÂÃÅÈÉÊËÌÍÎÏÒÓÔÕÙÚÛÝ]/g, '');
    if (letters.length < 6) continue;
    let vowels = 0;
    for (const ch of letters) if (vowelChars.includes(ch)) vowels++;
    const vowelRatio = vowels / letters.length;
    let transitions = 0;
    for (let i = 1; i < letters.length; i++) {
      const prevUpper = letters[i - 1] === letters[i - 1].toUpperCase() && letters[i - 1] !== letters[i - 1].toLowerCase();
      const curUpper = letters[i] === letters[i].toUpperCase() && letters[i] !== letters[i].toLowerCase();
      if (prevUpper !== curUpper) transitions++;
    }
    const transitionRatio = transitions / (letters.length - 1);
    // Tiered threshold: longer strings need a less extreme vowel-ratio to be flagged,
    // since genuine long words (esp. German compounds) always carry a healthy vowel
    // share, while short strings need a stricter cutoff to avoid catching real
    // camelCase brand names (McDonald, PayPal, JavaScript...).
    const vowelThreshold = letters.length >= 14 ? 0.28 : (letters.length >= 11 ? 0.22 : 0.16);
    if (vowelRatio < vowelThreshold && transitionRatio > 0.3) return true;
  }
  if (/\S{61,}/.test(str || '')) return true;
  return false;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid request.' });

  // Honeypot
  if (body['_website'] && body['_website'].trim() !== '') return res.status(200).json({ ok: true });

  // Dwell-time
  const elapsed = parseInt(body.elapsed, 10) || 0;
  if (elapsed < 3000) {
    console.log('Bot rejected: dwell', elapsed, 'ms');
    return res.status(200).json({ ok: true });
  }

  const email    = sanitize(body.email    || '');
  const name     = sanitize(body.name     || '');
  const subject  = sanitize(body.subject  || 'Anfrage / Enquiry');
  const nachricht= sanitize(body.nachricht|| '');

  // Gibberish-Bot-Erkennung (kurze Zufallsstrings) — silent success wie Honeypot
  if (isGibberish(nachricht) || isGibberish(name) || BLOCKED_EMAILS.has(normalizeEmail(email))) return res.status(200).json({ ok: true });

  if (!email || !nachricht) {
    return res.status(400).json({ error: 'Email and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  // Content filter
  if (!looksHuman(nachricht)) {
    console.log('Bot rejected: content filter');
    return res.status(200).json({ ok: true });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY missing');
    return res.status(500).json({ error: 'Configuration error. Please email info@sunny-beach.xyz' });
  }

  const ts = new Date().toLocaleString('de-DE', { timeZone: 'Asia/Bangkok' });

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#1a2a20;max-width:600px;margin:0 auto">
<h2 style="color:#0B4F6C;border-bottom:3px solid #00BFA6;padding-bottom:.5rem">
  ☀️ Sunny Beach Pattaya — New Enquiry
</h2>
<table style="width:100%;border-collapse:collapse;margin:1rem 0">
  <tr><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4;font-weight:bold;width:110px">Name</td><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4">${name||'–'}</td></tr>
  <tr><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4;font-weight:bold">Email</td><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4"><a href="mailto:${email}">${email}</a></td></tr>
  <tr><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4;font-weight:bold">Subject</td><td style="padding:.5rem .8rem;border-bottom:1px solid #e0f7f4">${subject}</td></tr>
</table>
<p><strong>Message:</strong></p>
<div style="background:#e0f7f4;border-left:3px solid #00BFA6;padding:1rem;white-space:pre-wrap">${nachricht.replace(/\n/g,'<br>')}</div>
<p style="font-size:11px;color:#aaa;margin-top:2rem;border-top:1px solid #e0f7f4;padding-top:.5rem">
  sunny-beach.xyz · IP: ${ip} · ${ts} (Bangkok time)
</p>
</body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     'Sunny Beach <noreply@pan21.com>',
        to:       ['info@sunny-beach.xyz'],
        reply_to: email,
        subject:  `☀️ Sunny Beach – ${subject}`,
        html:     html,
      }),
    });

    const responseText = await r.text();
    console.log('Resend Status:', r.status, responseText);

    if (!r.ok) {
      return res.status(500).json({ error: 'Could not send message. Please email info@sunny-beach.xyz' });
    }

    // Auto-reply to visitor
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Sunny Beach <noreply@pan21.com>',
        to:      [email],
        subject: '☀️ Thank you – Sunny Beach Pattaya',
        html:    `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#1a2a20;max-width:600px;margin:0 auto">
<h2 style="color:#0B4F6C;border-bottom:3px solid #00BFA6;padding-bottom:.5rem">☀️ Thank you for your message!</h2>
<p>Dear ${name||'Guest'},</p>
<p>We have received your message and will get back to you as soon as possible.</p>
<p>See you at <strong>Sunny Beach, Dongtan Beach, Jomtien, Pattaya!</strong> 🌊</p>
<p style="margin-top:1.5rem">Warm regards,<br><strong>Tum & Team — Sunny Beach Pattaya</strong><br>
<a href="https://sunny-beach.xyz">sunny-beach.xyz</a></p>
<hr style="border:none;border-top:1px solid #e0f7f4;margin:1.5rem 0">
<p style="color:#666;font-size:.85em">
  🇩🇪 Vielen Dank für Ihre Nachricht! Wir melden uns so bald wie möglich.<br>
  🇹🇭 ขอบคุณสำหรับข้อความของคุณ เราจะติดต่อกลับโดยเร็วที่สุด
</p>
</body></html>`,
      }),
    }).catch(e => console.log('Auto-reply failed:', e.message));

    return res.status(200).json({ ok: true, message: 'Message sent successfully.' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'Connection error. Please email info@sunny-beach.xyz' });
  }
};
