/**
 * Eva Voice Server
 * Twilio + Claude AI phone assistant — English only
 *
 * Flow: Caller → Twilio → /voice/incoming → Claude AI → TwiML response
 *       (if AI can't handle) → forward to salon's real phone number
 */

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const twilio     = require('twilio');
const Anthropic  = require('@anthropic-ai/sdk');

// ─── Validation ───────────────────────────────────────────────────────────────
const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SALON_PHONE_NUMBER'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required env vars:', missing.join(', '));
  console.error('   Copy .env.example → .env and fill in your keys.');
  process.exit(1);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Call sessions stored in memory — use Redis in production
// Key: CallSid → { messages: [], callerNumber, attempts }
const sessions = new Map();

// ─── Config ───────────────────────────────────────────────────────────────────
const SALON_NAME     = process.env.SALON_NAME     || 'Riverland Nails Spa';
const SALON_PHONE    = process.env.SALON_PHONE_NUMBER;
const TWILIO_PHONE   = process.env.TWILIO_PHONE_NUMBER;
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday–Saturday 9am–7pm, Sunday 10am–6pm';
const SERVICES       = (process.env.SERVICES || 'Manicure ($25)|Pedicure ($35)|Gel Manicure ($40)|Full Set Acrylic ($55)|Full Set + Pedicure ($80)|Nail Art (from $10)').replace(/\|/g, '\n- ');
const MAX_ATTEMPTS   = 4; // max no-speech attempts before forwarding

// Fixed: English only, Polly.Joanna voice
const SAY_OPTS = { voice: 'Polly.Joanna', language: 'en-US' };

// ─── Validate Twilio signature (security) ─────────────────────────────────────
function validateTwilio(req, res, next) {
  // Skip validation in local dev
  if (process.env.NODE_ENV === 'development' || !process.env.PUBLIC_URL) {
    return next();
  }
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    `${process.env.PUBLIC_URL}${req.originalUrl}`,
    req.body,
    req.headers['x-twilio-signature']
  );
  if (!valid) {
    console.warn('⚠️  Invalid Twilio signature — request rejected');
    return res.status(403).send('Forbidden');
  }
  next();
}

// ─── Helper: Forward call to real salon phone ─────────────────────────────────
function forwardToSalon(twiml, res, announcement) {
  if (announcement) {
    twiml.say(SAY_OPTS, announcement);
  }
  const dial = twiml.dial({ callerId: TWILIO_PHONE || undefined, timeout: 30 });
  dial.number(SALON_PHONE);
  res.type('text/xml');
  return res.send(twiml.toString());
}

// ─── Helper: Build Claude system prompt ───────────────────────────────────────
function buildSystemPrompt(callerNumber, today) {
  return `You are Eva, the AI phone assistant for ${SALON_NAME}.
Today is ${today}.
Caller's phone number: ${callerNumber}

Services available:
- ${SERVICES}

Business hours: ${BUSINESS_HOURS}

IMPORTANT RULES:
1. Keep responses SHORT — 2 to 3 sentences max. This is a phone call, not a chat.
2. Do NOT use markdown, bullet points, asterisks, or special characters. Speak naturally.
3. Be warm, friendly, and professional.
4. To book an appointment: ask for the service, preferred date and time, and the caller's name.
5. Once an appointment is confirmed, append exactly: [BOOKED: name=X, service=X, date=X, time=X]
6. If the caller wants to speak with a real person or the request is too complex, append exactly: [FORWARD]
7. When the conversation is fully complete (appointment booked, all questions answered), append exactly: [DONE]
8. Never append more than one tag per response.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Incoming call ──────────────────────────────────────────────────────────
app.post('/voice/incoming', validateTwilio, (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const caller  = req.body.From || 'Unknown';

  sessions.set(callSid, { messages: [], callerNumber: caller, attempts: 0 });
  console.log(`📞 Incoming call | SID: ${callSid} | From: ${caller}`);

  const greeting = `Hello! Thank you for calling ${SALON_NAME}. I'm Eva, your AI assistant. I can help you book an appointment, check availability, or answer questions about our services. How can I help you today?`;

  const gather = twiml.gather({
    input:         'speech',
    action:        '/voice/process',
    method:        'POST',
    timeout:       6,
    speechTimeout: 'auto',
    language:      'en-US',
  });
  gather.say(SAY_OPTS, greeting);

  // No input → repeat greeting
  twiml.redirect('/voice/incoming');

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 2. Process speech → Claude AI ────────────────────────────────────────────
app.post('/voice/process', validateTwilio, async (req, res) => {
  const twiml        = new twilio.twiml.VoiceResponse();
  const callSid      = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const caller       = req.body.From || 'Unknown';

  const session = sessions.get(callSid) || { messages: [], callerNumber: caller, attempts: 0 };
  session.attempts++;
  sessions.set(callSid, session);

  // No speech detected
  if (!speechResult || speechResult.trim() === '') {
    if (session.attempts >= MAX_ATTEMPTS) {
      return forwardToSalon(twiml, res,
        "I'm having trouble hearing you. Let me connect you to our team."
      );
    }
    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/process',
      method:        'POST',
      timeout:       6,
      speechTimeout: 'auto',
      language:      'en-US',
    });
    gather.say(SAY_OPTS, "I'm sorry, I didn't catch that. Could you please repeat?");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  console.log(`🎤 Speech: "${speechResult}" | SID: ${callSid}`);
  session.messages.push({ role: 'user', content: speechResult });

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    // Call Claude with prompt caching on the system prompt
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system: [
        {
          type:          'text',
          text:          buildSystemPrompt(session.callerNumber, today),
          cache_control: { type: 'ephemeral' }, // saves tokens on repeated calls
        },
      ],
      messages: session.messages,
    });

    const aiText = response.content[0].text.trim();
    console.log(`🤖 AI: "${aiText}"`);

    session.messages.push({ role: 'assistant', content: aiText });
    sessions.set(callSid, session);

    // ── Parse special tags ────────────────────────────────────────────────────

    // [FORWARD] → transfer to real salon phone
    if (aiText.includes('[FORWARD]')) {
      const cleanText = aiText.replace('[FORWARD]', '').trim();
      return forwardToSalon(twiml, res,
        cleanText || 'Let me connect you to our team right away.'
      );
    }

    // [DONE] → end the call gracefully
    if (aiText.includes('[DONE]')) {
      const cleanText = aiText.replace('[DONE]', '').trim();
      if (cleanText) twiml.say(SAY_OPTS, cleanText);
      twiml.say(SAY_OPTS, 'Thank you for calling. We look forward to seeing you at the salon!');
      twiml.hangup();
      sessions.delete(callSid);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // [BOOKED: ...] → log booking, ask if anything else needed
    if (aiText.includes('[BOOKED:')) {
      const match = aiText.match(/\[BOOKED:(.*?)\]/);
      if (match) {
        console.log(`✅ Booking created | ${match[1].trim()} | Caller: ${session.callerNumber}`);
        // TODO: call your booking API here
        // await createAppointment(match[1], session.callerNumber);
      }
      const cleanText = aiText.replace(/\[BOOKED:.*?\]/g, '').trim();

      const gather = twiml.gather({
        input:         'speech',
        action:        '/voice/process',
        method:        'POST',
        timeout:       5,
        speechTimeout: 'auto',
        language:      'en-US',
      });
      const msg = cleanText
        ? `${cleanText} Is there anything else I can help you with?`
        : 'Is there anything else I can help you with?';
      gather.say(SAY_OPTS, msg);
      twiml.redirect('/voice/incoming');
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Normal response → keep listening
    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/process',
      method:        'POST',
      timeout:       5,
      speechTimeout: 'auto',
      language:      'en-US',
    });
    gather.say(SAY_OPTS, aiText);
    twiml.redirect('/voice/incoming');

  } catch (err) {
    console.error('❌ Claude API error:', err.message);
    return forwardToSalon(twiml, res,
      'I apologize for the technical issue. Let me connect you to our team.'
    );
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 3. Incoming SMS ───────────────────────────────────────────────────────────
app.post('/sms/incoming', validateTwilio, async (req, res) => {
  const twiml        = new twilio.twiml.MessagingResponse();
  const body         = req.body.Body?.trim() || '';
  const senderNumber = req.body.From || 'Unknown';

  console.log(`💬 SMS from ${senderNumber}: "${body}"`);

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: `You are Eva, the AI SMS assistant for ${SALON_NAME}.
Today is ${today}.
Services: ${SERVICES}
Business hours: ${BUSINESS_HOURS}
Customer's number: ${senderNumber}

RULES:
- Reply in English only.
- Keep replies SHORT (under 160 characters if possible, 320 max).
- No markdown or special formatting.
- If booking is confirmed, append: [BOOKED: name=X, service=X, date=X, time=X]
- If a staff member needs to follow up, append: [NEEDS_HUMAN]`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: body }],
    });

    let aiText = response.content[0].text.trim();

    if (aiText.includes('[BOOKED:')) {
      const match = aiText.match(/\[BOOKED:(.*?)\]/);
      if (match) console.log(`✅ SMS Booking: ${match[1]} | ${senderNumber}`);
      aiText = aiText.replace(/\[BOOKED:.*?\]/g, '').trim();
    }

    if (aiText.includes('[NEEDS_HUMAN]')) {
      aiText = aiText.replace('[NEEDS_HUMAN]', '').trim();
      if (aiText) twiml.message(aiText);
      twiml.message(`Our team will get back to you shortly! Or call us directly at ${SALON_PHONE}.`);
    } else {
      twiml.message(aiText);
    }

  } catch (err) {
    console.error('❌ SMS AI error:', err.message);
    twiml.message(`Thanks for your message! Our team will reply shortly. Call us at ${SALON_PHONE}.`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 4. Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    service:     'Eva Voice & SMS Server',
    salon:       SALON_NAME,
    language:    'en-US',
    activeCalls: sessions.size,
    timestamp:   new Date().toISOString(),
  });
});

// ── 5. TwiML test (dev only) ──────────────────────────────────────────────────
app.get('/test-twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(SAY_OPTS, `Hello! This is ${SALON_NAME}. Eva is ready.`);
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 6. Clean up stale sessions every hour ────────────────────────────────────
setInterval(() => {
  for (const [sid] of sessions) {
    sessions.delete(sid);
  }
}, 60 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Eva Voice Server  🤖📞             ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port     : ${PORT.toString().padEnd(26)}║`);
  console.log(`║  Salon    : ${SALON_NAME.substring(0, 26).padEnd(26)}║`);
  console.log(`║  Language : ${'English (en-US)'.padEnd(26)}║`);
  console.log(`║  Voice    : ${'Polly.Joanna'.padEnd(26)}║`);
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Endpoints:                          ║');
  console.log('║  POST /voice/incoming  (call)        ║');
  console.log('║  POST /voice/process   (AI)          ║');
  console.log('║  POST /sms/incoming    (SMS)         ║');
  console.log('║  GET  /health                        ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  if (process.env.PUBLIC_URL) {
    console.log(`🌐 Voice Webhook: ${process.env.PUBLIC_URL}/voice/incoming`);
    console.log(`💬 SMS Webhook  : ${process.env.PUBLIC_URL}/sms/incoming`);
  } else {
    console.log('⚠️  PUBLIC_URL not set in .env');
    console.log('   Local dev: npx ngrok http 3000  →  copy URL to .env');
  }
  console.log('');
});
