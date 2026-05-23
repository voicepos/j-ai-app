/**
 * J-AI Voice Server
 * Twilio + Claude AI phone assistant for Riverland Nails Spa
 *
 * Flow: Người gọi → Twilio → [server này] → Claude AI → TwiML response
 *       (nếu AI không xử lý được → forward đến số salon thật)
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Validation ──────────────────────────────────────────────────────────────
const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SALON_PHONE_NUMBER'];
const missing = required.filter(k => !process.env[k]);
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

// Lưu session cuộc gọi trong memory (dùng Redis trong production)
// Key: CallSid → { messages: [], callerNumber, attempts }
const sessions = new Map();

// ─── Config ───────────────────────────────────────────────────────────────────
const SALON_NAME     = process.env.SALON_NAME     || 'Riverland Nails Spa';
const SALON_PHONE    = process.env.SALON_PHONE_NUMBER;
const TWILIO_PHONE   = process.env.TWILIO_PHONE_NUMBER;
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday-Saturday 9am-7pm, Sunday 10am-6pm';
const SERVICES       = (process.env.SERVICES || 'Manicure ($25)|Pedicure ($35)|Gel Manicure ($40)|Full Set ($55)').replace(/\|/g, '\n- ');
const LANGUAGE       = process.env.DEFAULT_LANGUAGE || 'en-US';
const MAX_ATTEMPTS   = 4; // Số lần thử tối đa trước khi forward

// ─── Validate Twilio signature (bảo mật) ─────────────────────────────────────
function validateTwilio(req, res, next) {
  // Bỏ qua validation khi dev local
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

// ─── Helper: Build TwiML Say ──────────────────────────────────────────────────
/**
 * Chọn giọng đọc phù hợp theo ngôn ngữ:
 *   vi-VN → Polly.Linh  (giọng Việt nữ)
 *   en-US → Polly.Joanna (giọng Anh nữ)
 */
function sayOptions() {
  return LANGUAGE === 'vi-VN'
    ? { voice: 'Polly.Linh', language: 'vi-VN' }
    : { voice: 'Polly.Joanna', language: 'en-US' };
}

// ─── Helper: Forward đến số salon thật ───────────────────────────────────────
function forwardToSalon(twiml, res, announcement) {
  if (announcement) {
    twiml.say(sayOptions(), announcement);
  }
  const dial = twiml.dial({ callerId: TWILIO_PHONE || undefined, timeout: 30 });
  dial.number(SALON_PHONE);
  res.type('text/xml');
  return res.send(twiml.toString());
}

// ─── Helper: Tạo system prompt cho Claude ────────────────────────────────────
function buildSystemPrompt(callerNumber, today) {
  const lang = LANGUAGE === 'vi-VN' ? 'Tiếng Việt' : 'English';
  return `Bạn là J-AI, trợ lý AI điện thoại cho ${SALON_NAME}.
Hôm nay: ${today}
Ngôn ngữ giao tiếp: ${lang}

Dịch vụ của salon:
- ${SERVICES}

Giờ làm việc: ${BUSINESS_HOURS}
Số điện thoại khách gọi: ${callerNumber}

QUY TẮC QUAN TRỌNG:
1. Câu trả lời NGẮN GỌN (tối đa 2-3 câu) — đây là cuộc gọi thoại, không phải chat.
2. KHÔNG dùng markdown, dấu gạch đầu dòng, dấu *, hoặc ký tự đặc biệt.
3. Nói tự nhiên, ấm áp, chuyên nghiệp.
4. Nếu khách muốn đặt lịch: hỏi dịch vụ, ngày giờ mong muốn, tên khách hàng.
5. Sau khi xác nhận đặt lịch thành công, thêm: [BOOKED: name=X, service=X, date=X, time=X]
6. Nếu khách muốn nói chuyện với người thật hoặc yêu cầu phức tạp hơn, thêm: [FORWARD]
7. Nếu cuộc trò chuyện đã hoàn tất (đã đặt lịch xong, không còn yêu cầu nào), thêm: [DONE]
8. Không thêm nhiều tag một lúc.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Cuộc gọi đến lần đầu ─────────────────────────────────────────────────
app.post('/voice/incoming', validateTwilio, (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const caller  = req.body.From || 'Unknown';

  // Khởi tạo session
  sessions.set(callSid, { messages: [], callerNumber: caller, attempts: 0 });

  console.log(`📞 Incoming call | SID: ${callSid} | From: ${caller}`);

  const loi_chao = LANGUAGE === 'vi-VN'
    ? `Xin chào! Cảm ơn bạn đã gọi đến ${SALON_NAME}. Tôi là J-AI, trợ lý AI của salon. Tôi có thể giúp bạn đặt lịch, kiểm tra lịch trống, hoặc trả lời câu hỏi về dịch vụ. Bạn cần hỗ trợ gì ạ?`
    : `Hello! Thank you for calling ${SALON_NAME}. I'm J-AI, your AI assistant. I can help you book an appointment, check availability, or answer questions about our services. How can I help you today?`;

  const gather = twiml.gather({
    input:          'speech',
    action:         '/voice/process',
    method:         'POST',
    timeout:        6,
    speechTimeout:  'auto',
    language:       LANGUAGE,
  });
  gather.say(sayOptions(), loi_chao);

  // Nếu không có đầu vào → lặp lại
  twiml.redirect('/voice/incoming');

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 2. Xử lý giọng nói → Claude AI ──────────────────────────────────────────
app.post('/voice/process', validateTwilio, async (req, res) => {
  const twiml        = new twilio.twiml.VoiceResponse();
  const callSid      = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const caller       = req.body.From || 'Unknown';

  const session = sessions.get(callSid) || { messages: [], callerNumber: caller, attempts: 0 };
  session.attempts++;
  sessions.set(callSid, session);

  // Không nhận được giọng nói
  if (!speechResult || speechResult.trim() === '') {
    if (session.attempts >= MAX_ATTEMPTS) {
      return forwardToSalon(twiml, res,
        LANGUAGE === 'vi-VN'
          ? 'Tôi không nghe rõ bạn. Hãy để tôi kết nối bạn với nhân viên salon nhé.'
          : 'I\'m having trouble hearing you. Let me connect you to our team.'
      );
    }

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/process',
      method:        'POST',
      timeout:       6,
      speechTimeout: 'auto',
      language:      LANGUAGE,
    });
    gather.say(sayOptions(),
      LANGUAGE === 'vi-VN'
        ? 'Xin lỗi, tôi không nghe rõ. Bạn có thể nói lại không ạ?'
        : 'I\'m sorry, I didn\'t catch that. Could you please repeat?'
    );
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  console.log(`🎤 Speech: "${speechResult}" | SID: ${callSid}`);

  // Thêm tin nhắn khách vào lịch sử
  session.messages.push({ role: 'user', content: speechResult });

  try {
    const today = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // Gọi Claude API với prompt caching cho system prompt
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(session.callerNumber, today),
          cache_control: { type: 'ephemeral' },   // prompt caching → tiết kiệm token
        }
      ],
      messages: session.messages,
    });

    const aiText = response.content[0].text.trim();
    console.log(`🤖 AI reply: "${aiText}"`);

    // Lưu câu trả lời AI vào session
    session.messages.push({ role: 'assistant', content: aiText });
    sessions.set(callSid, session);

    // ── Phân tích tag đặc biệt ──────────────────────────────────────────────

    // [FORWARD] → chuyển đến số thật
    if (aiText.includes('[FORWARD]')) {
      const cleanText = aiText.replace('[FORWARD]', '').trim();
      return forwardToSalon(twiml, res, cleanText ||
        (LANGUAGE === 'vi-VN'
          ? 'Hãy để tôi kết nối bạn với nhân viên salon nhé.'
          : 'Let me connect you to our team.')
      );
    }

    // [DONE] → kết thúc cuộc gọi
    if (aiText.includes('[DONE]')) {
      const cleanText = aiText.replace('[DONE]', '').trim();
      if (cleanText) twiml.say(sayOptions(), cleanText);
      twiml.say(sayOptions(),
        LANGUAGE === 'vi-VN'
          ? 'Cảm ơn bạn đã gọi đến. Hẹn gặp lại bạn tại salon!'
          : 'Thank you for calling. We look forward to seeing you at the salon!'
      );
      twiml.hangup();
      sessions.delete(callSid);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // [BOOKED: ...] → đặt lịch thành công, log và tiếp tục
    if (aiText.includes('[BOOKED:')) {
      const match = aiText.match(/\[BOOKED:(.*?)\]/);
      if (match) {
        const bookingInfo = match[1].trim();
        console.log(`✅ Booking created | ${bookingInfo} | Caller: ${session.callerNumber}`);
        // TODO: gọi API booking system của bạn ở đây
        // await createAppointment(bookingInfo, session.callerNumber);
      }
      const cleanText = aiText.replace(/\[BOOKED:.*?\]/g, '').trim();

      // Tiếp tục hỏi xem có gì khác không
      const gather = twiml.gather({
        input:         'speech',
        action:        '/voice/process',
        method:        'POST',
        timeout:       5,
        speechTimeout: 'auto',
        language:      LANGUAGE,
      });
      const follow_up = LANGUAGE === 'vi-VN' ? 'Bạn cần thêm gì nữa không ạ?' : 'Is there anything else I can help you with?';
      gather.say(sayOptions(), cleanText ? `${cleanText} ${follow_up}` : follow_up);
      twiml.redirect('/voice/incoming');
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Phản hồi bình thường → tiếp tục ghi âm
    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/process',
      method:        'POST',
      timeout:       5,
      speechTimeout: 'auto',
      language:      LANGUAGE,
    });
    gather.say(sayOptions(), aiText);
    twiml.redirect('/voice/incoming');

  } catch (err) {
    console.error('❌ Claude API error:', err.message);
    return forwardToSalon(twiml, res,
      LANGUAGE === 'vi-VN'
        ? 'Xin lỗi, có sự cố kỹ thuật. Hãy để tôi kết nối bạn với nhân viên salon.'
        : 'I apologize for the technical issue. Let me connect you to our team.'
    );
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 3. SMS đến ────────────────────────────────────────────────────────────────
app.post('/sms/incoming', validateTwilio, async (req, res) => {
  const twiml        = new twilio.twiml.MessagingResponse();
  const body         = req.body.Body?.trim() || '';
  const senderNumber = req.body.From || 'Unknown';

  console.log(`💬 SMS from ${senderNumber}: "${body}"`);

  try {
    const today = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: `Bạn là J-AI, trợ lý AI của ${SALON_NAME} qua SMS.
Hôm nay: ${today}
Dịch vụ: ${SERVICES}
Giờ làm việc: ${BUSINESS_HOURS}
Số khách nhắn tin: ${senderNumber}

QUY TẮC:
- Trả lời NGẮN GỌN (dưới 160 ký tự nếu có thể, tối đa 320 ký tự).
- Không dùng markdown phức tạp.
- Nếu đặt lịch thành công: thêm [BOOKED: name=X, service=X, date=X, time=X].
- Nếu cần nhân viên xử lý: thêm [NEEDS_HUMAN].`,
          cache_control: { type: 'ephemeral' },
        }
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
      twiml.message(`Nhân viên của chúng tôi sẽ liên hệ lại với bạn sớm nhé! Hoặc gọi thẳng: ${SALON_PHONE}`);
    } else {
      twiml.message(aiText);
    }

  } catch (err) {
    console.error('❌ SMS AI error:', err.message);
    twiml.message(`Cảm ơn tin nhắn của bạn! Nhân viên sẽ phản hồi sớm nhất. Gọi ngay: ${SALON_PHONE}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 4. Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    service:     'J-AI Voice & SMS Server',
    salon:       SALON_NAME,
    activeCalls: sessions.size,
    timestamp:   new Date().toISOString(),
  });
});

// ── 5. Webhook test (dev only) ────────────────────────────────────────────────
app.get('/test-twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(sayOptions(), `Xin chào! Đây là ${SALON_NAME}. J-AI đã sẵn sàng.`);
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 6. Dọn session cũ (mỗi giờ) ─────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 giờ
  for (const [sid, _] of sessions) {
    // Xóa session không hoạt động (không có createdAt → xóa hết khi restart)
    sessions.delete(sid);
  }
}, 60 * 60 * 1000);

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   J-AI Voice Server  🤖📞            ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port     : ${PORT.toString().padEnd(26)}║`);
  console.log(`║  Salon    : ${SALON_NAME.substring(0, 26).padEnd(26)}║`);
  console.log(`║  Language : ${LANGUAGE.padEnd(26)}║`);
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Webhook endpoints:                  ║');
  console.log('║  POST /voice/incoming  (Twilio call) ║');
  console.log('║  POST /voice/process   (AI handler)  ║');
  console.log('║  POST /sms/incoming    (Twilio SMS)  ║');
  console.log('║  GET  /health          (status)      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  if (process.env.PUBLIC_URL) {
    console.log(`🌐 Twilio Voice Webhook: ${process.env.PUBLIC_URL}/voice/incoming`);
    console.log(`💬 Twilio SMS Webhook  : ${process.env.PUBLIC_URL}/sms/incoming`);
  } else {
    console.log('⚠️  PUBLIC_URL not set — set it in .env for Twilio webhooks.');
    console.log('   For local dev: npx ngrok http 3000  →  copy https URL to .env');
  }
});
