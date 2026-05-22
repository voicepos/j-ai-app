// /api/status — kiểm tra kết nối các dịch vụ
export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'J-AI Salon Phone Agent',
    timestamp: new Date().toISOString(),
    env: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      twilio: !!process.env.TWILIO_ACCOUNT_SID,
    }
  });
}
