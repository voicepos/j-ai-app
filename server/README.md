# J-AI Voice Server 🤖📞

Backend server kết nối **Twilio** + **Claude AI** để xử lý cuộc gọi điện thoại tự động cho salon.

## Luồng hoạt động

```
Người gọi → Twilio → /voice/incoming → Claude AI → TwiML response
                                      ↓ (nếu AI không xử lý được)
                                  → /voice/forward → Số salon thật
```

## Yêu cầu

- Node.js >= 18
- Tài khoản Twilio (có số điện thoại)
- Claude API key (Anthropic)
- Server public (Railway, Render, Heroku, hoặc ngrok cho dev)

---

## Cài đặt

```bash
cd server
npm install
cp .env.example .env
# Điền thông tin vào .env
npm start
```

---

## Cấu hình Twilio

1. Đăng nhập [console.twilio.com](https://console.twilio.com)
2. Mua hoặc dùng số điện thoại có sẵn
3. Vào **Phone Numbers → Manage → Active numbers → [số của bạn]**
4. Phần **Voice Configuration:**
   - **A call comes in** → `Webhook` → `POST`
   - URL: `https://your-server.com/voice/incoming`
5. Phần **Messaging Configuration:**
   - **A message comes in** → `Webhook` → `POST`
   - URL: `https://your-server.com/sms/incoming`

---

## Biến môi trường `.env`

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `TWILIO_ACCOUNT_SID` | ✅ | Account SID từ Twilio Console |
| `TWILIO_AUTH_TOKEN` | ✅ | Auth Token từ Twilio Console |
| `TWILIO_PHONE_NUMBER` | ✅ | Số Twilio bạn mua (e.g. `+19545550100`) |
| `SALON_PHONE_NUMBER` | ✅ | Số thật của salon (để forward khi cần) |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key từ console.anthropic.com |
| `SALON_NAME` | ☑️ | Tên salon (mặc định: Riverland Nails Spa) |
| `BUSINESS_HOURS` | ☑️ | Giờ làm việc |
| `SERVICES` | ☑️ | Danh sách dịch vụ (ngăn cách bởi `\|`) |
| `DEFAULT_LANGUAGE` | ☑️ | `vi-VN` hoặc `en-US` |
| `PUBLIC_URL` | ☑️ | URL public của server |
| `PORT` | ☑️ | Port server (mặc định: 3000) |

---

## Test local với ngrok

```bash
# Terminal 1 — chạy server
npm run dev

# Terminal 2 — expose public URL
npx ngrok http 3000

# Copy URL dạng https://abc123.ngrok-free.app
# Paste vào .env → PUBLIC_URL=https://abc123.ngrok-free.app
# Cũng paste vào Twilio Console webhook
```

## Test TwiML (không cần Twilio)
```
GET http://localhost:3000/test-twiml
```

---

## Deploy lên Railway (khuyến nghị)

```bash
# Cài Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up

# Set env vars trên dashboard Railway
```

Railway sẽ tự cấp HTTPS URL → dùng làm webhook cho Twilio.

---

## Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| `POST` | `/voice/incoming` | Twilio gọi khi có cuộc gọi đến |
| `POST` | `/voice/process` | Xử lý giọng nói qua Claude AI |
| `POST` | `/sms/incoming` | Xử lý SMS qua Claude AI |
| `GET` | `/health` | Kiểm tra trạng thái server |
| `GET` | `/test-twiml` | Test TwiML response (dev) |

---

## Cách AI phản hồi

Claude sẽ tự động:
- **Đặt lịch**: hỏi dịch vụ → ngày giờ → xác nhận → gắn thẻ `[BOOKED: ...]`
- **Chuyển tiếp**: nếu yêu cầu phức tạp → gắn thẻ `[FORWARD]` → dial đến salon
- **Kết thúc**: khi xong việc → gắn thẻ `[DONE]` → cúp máy lịch sự

---

## Tích hợp vào hệ thống booking

Tại file `server.js`, tìm comment `// TODO: gọi API booking system` để thêm logic lưu lịch hẹn:

```javascript
// Ví dụ: gọi webhook của j-ai-app
await fetch(`${process.env.APP_URL}/api/bookings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ caller: senderNumber, ...bookingDetails })
});
```
