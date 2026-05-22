// /api/voice — Twilio incoming call webhook
// Khách gọi vào → AI J-AI chào và hỏi cần gì

const twilio = require('twilio');

export default function handler(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    action: '/api/gather',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    language: 'en-US',
    timeout: 5,
  });

  gather.say(
    { voice: 'Polly.Joanna-Neural' },
    "Thank you for calling Riverland Nails Spa! " +
    "I'm J-AI, your virtual assistant. " +
    "I can help you book an appointment, check your appointment, or answer questions about our services. " +
    "How can I help you today?"
  );

  // Nếu không nghe được gì
  twiml.say(
    { voice: 'Polly.Joanna-Neural' },
    "I'm sorry, I didn't catch that. Please call back and we'll be happy to help. Goodbye!"
  );
  twiml.hangup();

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}
