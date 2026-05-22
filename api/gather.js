// /api/gather — Xử lý giọng nói của khách → Claude AI → đặt lịch
import Anthropic from '@anthropic-ai/sdk';
import * as admin from 'firebase-admin';
import twilio from 'twilio';

// ── Firebase Admin init ──
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')
    ),
  });
}
const db = admin.firestore();

// ── Anthropic init ──
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── System prompt cho J-AI Phone Agent ──
const PHONE_SYSTEM = `You are J-AI, the AI phone receptionist for Riverland Nails Spa in Fort Lauderdale, FL.
Your job: help callers book appointments naturally and warmly.

SALON INFO:
- Hours: Mon-Sat 9AM-7PM, Sun 10AM-5PM
- Address: 2722 Davie Blvd, Fort Lauderdale, FL 33312

SERVICES & PRICES:
- Manicure: $25, 45 min
- Pedicure: $35, 60 min
- Gel Manicure: $40, 60 min
- Full Set Acrylic: $55, 90 min
- Full Set + Pedicure: $80, 120 min
- Nail Art add-on: from $20

RULES:
- Keep responses SHORT (under 40 words) — this is a phone call
- Be warm, professional, and natural
- Collect: customer name, desired service, preferred date, preferred time
- When you have all 4 pieces of info, respond ONLY with this exact JSON (nothing else):
  {"action":"BOOK","name":"...","service":"...","date":"...","time":"...","phone":"CALLER_PHONE"}
- If caller wants to cancel/reschedule, say a staff member will call them back
- If caller asks about prices/hours, answer briefly then ask how you can help
- If caller says goodbye/thank you/no more questions → respond with: {"action":"END"}`;

export default async function handler(req, res) {
  const { SpeechResult, CallSid, From, CallStatus } = req.body;

  // Handle call ended
  if (CallStatus === 'completed') {
    await db.collection('call_sessions').doc(CallSid).delete().catch(() => {});
    res.status(200).send('OK');
    return;
  }

  if (!SpeechResult) {
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      input: 'speech', action: '/api/gather', method: 'POST',
      speechTimeout: 'auto', language: 'en-US', timeout: 5,
    });
    gather.say({ voice: 'Polly.Joanna-Neural' },
      "I'm sorry, I didn't catch that. Could you please repeat?");
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }

  // ── Load conversation history ──
  const sessionRef = db.collection('call_sessions').doc(CallSid);
  const sessionSnap = await sessionRef.get();
  let messages = sessionSnap.exists ? (sessionSnap.data().messages || []) : [];

  // Add caller's speech
  messages.push({ role: 'user', content: SpeechResult });

  // ── Call Claude ──
  let aiText = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: PHONE_SYSTEM.replace('CALLER_PHONE', From || ''),
      messages: messages.slice(-10), // last 10 turns
    });
    aiText = response.content[0].text.trim();
  } catch (e) {
    console.error('Claude error:', e);
    aiText = "I'm having a technical issue. Please hold while I transfer you to our staff.";
  }

  // Add AI response to history
  messages.push({ role: 'assistant', content: aiText });

  // ── Save session ──
  await sessionRef.set({
    messages,
    callSid: CallSid,
    callerPhone: From,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── Parse Claude response ──
  const twiml = new twilio.twiml.VoiceResponse();
  let parsed = null;

  try {
    // Check if it's a JSON action
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) { /* not JSON */ }

  if (parsed?.action === 'BOOK') {
    // ── Save appointment to Firestore ──
    const today = new Date().toISOString().split('T')[0];
    const appt = {
      name: parsed.name,
      phone: From || parsed.phone || '',
      svc: parsed.service,
      time: parsed.time,
      date: parsed.date || today,
      tech: 'Any Available',
      status: 'confirmed',
      channel: 'phone-ai',
      notes: `Booked via AI phone agent. CallSid: ${CallSid}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('appointments').add(appt);

    // Add to activity feed
    await db.collection('activities').add({
      type: 'ai',
      title: '📞 AI booked via phone call',
      desc: `${parsed.name} — ${parsed.service} at ${parsed.time}`,
      time: 'Just now',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Clean up session
    await sessionRef.delete();

    const confirmMsg =
      `Perfect! I've booked a ${parsed.service} for ${parsed.name} ` +
      `on ${parsed.date} at ${parsed.time}. ` +
      `We'll send a confirmation text to confirm your appointment. ` +
      `Thank you for choosing Riverland Nails Spa! We look forward to seeing you. Goodbye!`;

    twiml.say({ voice: 'Polly.Joanna-Neural' }, confirmMsg);
    twiml.hangup();

  } else if (parsed?.action === 'END') {
    await sessionRef.delete();
    twiml.say({ voice: 'Polly.Joanna-Neural' },
      "Thank you for calling Riverland Nails Spa! Have a wonderful day. Goodbye!");
    twiml.hangup();

  } else {
    // Continue conversation
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/gather',
      method: 'POST',
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      language: 'en-US',
      timeout: 8,
    });
    gather.say({ voice: 'Polly.Joanna-Neural' }, aiText);

    // Timeout fallback
    twiml.say({ voice: 'Polly.Joanna-Neural' },
      "I didn't hear anything. Please call back if you need assistance. Goodbye!");
    twiml.hangup();
  }

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}
