# Mirror Bot: บอท copy-trade เหรียญมีม Solana (ทำงานได้จริง)

สร้างตามแนวคิดในวิดีโอ "Grok Bot — 24h session" โดยเปลี่ยนชื่อและโลโก้ใหม่ทั้งหมด

```
กระเป๋าเทรดเดอร์ที่เราตาม (leaders)
      │  ฟัง WebSocket แบบเรียลไทม์ (logsSubscribe)
      ▼
watcher.ts ── แยกว่าเป็นการซื้อหรือขาย จากยอดคงเหลือก่อน/หลังธุรกรรม
      ▼
agents.ts ── 6 เอเจนต์ให้คะแนน: SCAN · WHALE · NARRATIVE · SNIPER · RISK · EXIT
      │  ค่าเฉลี่ยถ่วงน้ำหนัก ≥ 0.75 และไม่มีตัวไหนสั่งห้าม (veto) → เข้า
      ▼
jupiter.ts ── Jupiter Swap API v2 (/order → เซ็น → /execute)
      ▼
engine.ts ── ขนาดไม้ 12% · TP +35% · SL −12% · trailing stop · ขายตามเมื่อ leader ขาย · จำกัดขาดทุนต่อวัน
      ▼
dashboard ── http://localhost:8787 (หน้าตาแบบในวิดีโอ)
```

## สิ่งที่ต้องมี

| สิ่งที่ต้องใช้ | ใช้ทำอะไร | ค่าใช้จ่าย |
|---|---|---|
| Node.js 22.6 ขึ้นไป | รันบอท (ไม่ต้อง `npm install` เพราะไม่มี dependency) | ฟรี |
| RPC ของ Solana เช่น [Helius](https://helius.dev), QuickNode | ฟังกระเป๋าและอ่านธุรกรรม | แพ็กเกจฟรีพอสำหรับทดลอง ถ้าใช้จริงควรใช้แบบเสียเงิน (ประมาณ $49/เดือนขึ้นไป) เพื่อความเร็ว |
| API key ของ Jupiter ([developers.jup.ag/portal](https://developers.jup.ag/portal)) | ขอราคาและส่งคำสั่ง swap | มีแบบฟรี |
| กระเป๋า Phantom/Solflare **ใบใหม่** | ใช้เทรดจริง (เฉพาะโหมด live) | ใส่เงินเท่าที่เสียได้เท่านั้น |
| รายชื่อกระเป๋าที่จะตาม | หาได้จาก GMGN, Birdeye, Cielo, Kolscan (ดูสถิติย้อนหลัง 7–30 วัน) | ฟรี |

## วิธีใช้

```bash
cp .env.example .env              # ใส่ RPC_URL และ JUP_API_KEY
cp wallets.example.json wallets.json   # ใส่ address ของกระเป๋าที่จะตาม
npm test                          # ทดสอบตัวเอง (ไม่ใช้เน็ต)
npm run sim                       # จำลองการซื้อ-ขายแบบครบวงจรด้วยตลาดปลอม
npm start                         # เริ่มบอท แล้วเปิด http://localhost:8787
```

1. **รันโหมด `MODE=paper` อย่างน้อย 1–2 สัปดาห์ก่อน** โหมดนี้ใช้ราคาและเส้นทาง swap จริงจาก Jupiter แต่ไม่ส่งธุรกรรม จึงเห็นผลที่ใกล้เคียงของจริง ถ้าโหมด paper ยังไม่กำไร โหมด live ก็จะไม่กำไรเช่นกัน
2. ถ้าผลดีแล้วค่อยเปลี่ยนเป็น `MODE=live` ใส่ `WALLET_SECRET_KEY` และเริ่มด้วย `MAX_SOL_PER_TRADE=0.05`
3. วิธีหยุดฉุกเฉิน: สร้างไฟล์ชื่อ `STOP` ในโฟลเดอร์ (บอทจะหยุดเปิดไม้ใหม่) หรือกดปุ่ม "Close all positions and stop" บนแดชบอร์ด (บอทจะขายทุกไม้และหยุด)
4. ถ้ากด Ctrl+C ไม้ที่เปิดอยู่จะยังค้างอยู่ รันใหม่เมื่อไหร่บอทจะกลับมาดูแลต่อ (สถานะเก็บไว้ใน `data/state.json`)

## ใช้ร่วมกับ Supabase + Vercel (ดูแดชบอร์ดจากมือถือได้ทุกที่)

```
[บอท]  ← ต้องรันบนเครื่องที่เปิดตลอด 24 ชม. (VPS / Railway / Fly.io / คอมที่บ้าน)
  │  ใช้ service role key (มีเฉพาะบนเครื่องบอท)
  ▼
[Supabase]  bot_state (อัปเดตทุก 3 วิ) · trades (ประวัติทุกไม้) · bot_commands (kill/resume)
  │  Realtime + Row Level Security (เห็นข้อมูลได้เฉพาะอีเมลที่อนุญาต)
  ▼
[Vercel]  หน้าเว็บ static + ล็อกอินด้วย magic link → ดูสด + กดหยุดบอทได้
```

**ทำไมไม่รันบอทบน Vercel:** Vercel เป็น serverless แต่ละ request ทำงานได้ไม่กี่วินาทีถึงไม่กี่นาทีแล้วถูกปิด จึงเปิด WebSocket ค้างไว้ฟังกระเป๋าตลอดเวลาไม่ได้ และไม่ควรเก็บ private key ไว้บนแพลตฟอร์มเว็บ

### ขั้นตอน

1. **Supabase:** สร้างโปรเจกต์ → SQL Editor → วางไฟล์ `supabase/schema.sql` → **แก้อีเมลบรรทัดสุดท้ายเป็นอีเมลของคุณ** → Run
2. **Supabase → Authentication → URL Configuration:** ใส่ Site URL เป็นโดเมน Vercel ของคุณ เช่น `https://mirror-bot.vercel.app` (ถ้าไม่ใส่ ลิงก์ล็อกอินจะพากลับไปที่ localhost) และแนะนำให้ปิด "Allow new users to sign up" เพราะเราใช้อีเมลเดียว
3. **บอท:** ในไฟล์ `.env` บนเครื่องที่รันบอท ใส่ `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API) แล้ว `npm start` จะเห็นข้อความ `supabase sync on`
4. **Vercel:** push โปรเจกต์ขึ้น GitHub (ไฟล์ `.env` ถูก .gitignore ไว้แล้ว) → Import ใน Vercel → Environment Variables ใส่
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (คีย์ "anon public" เปิดเผยได้ เพราะ RLS ป้องกันข้อมูลไว้)
   - ห้ามใส่ `SUPABASE_SERVICE_ROLE_KEY` บน Vercel (สคริปต์ build จะไม่ยอม build ถ้าเจอ)
   
   ไฟล์ `vercel.json` ตั้งค่าไว้แล้ว กด Deploy ได้เลย
5. เปิดเว็บ → ใส่อีเมล → กดลิงก์ในอีเมล → เห็นข้อมูลสด ถ้าบอทไม่ส่งข้อมูลเกิน 60 วินาที ป้ายจะเปลี่ยนเป็น OFFLINE

### ที่รันบอทตลอด 24 ชม.

| ตัวเลือก | ราคาโดยประมาณ | หมายเหตุ |
|---|---|---|
| คอมที่บ้าน | ฟรี | ต้องเปิดเครื่องและต่อเน็ตตลอด |
| VPS (Hetzner, DigitalOcean, Vultr สิงคโปร์) | ~$5–6/เดือน | แนะนำ ใช้ `Dockerfile` หรือ `npm start` กับ pm2 |
| Railway / Fly.io / Render | ~$5+/เดือน | ตั้งเป็น "worker/background" ไม่ใช่ web service และต้องผูก volume ที่ `/app/data` |

ใส่ค่าใน `.env` เป็น environment variables ของแพลตฟอร์มนั้น และใช้ `BOT_ID` คนละค่าถ้าจะรันหลายบอทเข้าฐานข้อมูลเดียวกัน

## ความปลอดภัย

- private key ถูกอ่านจาก `.env` และใช้เซ็นในเครื่องเท่านั้น โค้ดจะไม่ส่ง key ไปที่ไหน
- บอทจะเซ็นเฉพาะธุรกรรมที่กระเป๋าเราเป็นผู้เซ็นที่ต้องเซ็นเท่านั้น
- แดชบอร์ดเปิดให้เข้าได้จาก `127.0.0.1` เท่านั้น
- ไม่มี npm dependency เลย จึงไม่มีความเสี่ยงจากแพ็กเกจปลอมที่ขโมย key ซึ่งพบบ่อยในวงการบอทคริปโต
- **อย่าติดตั้ง "SDK" หรือ "บอท" ที่ได้มาจาก TikTok หรือ Telegram** เช่น `@copyfomo/sdk` ในวิดีโอ ซึ่งไม่มีอยู่บน npm ถ้าวันหนึ่งมีคนปล่อยแพ็กเกจชื่อนี้ออกมา มีโอกาสสูงที่จะเป็นตัวขโมยกระเป๋า

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|---|---|
| `src/solana.ts` | base58, โหลดคีย์, เซ็นธุรกรรม (ed25519 ของ Node), JSON-RPC |
| `src/watcher.ts` | ฟังกระเป๋า leader และแยกการซื้อ/ขายออกจาก token transfer ธรรมดา |
| `src/market.ts` | DexScreener (สภาพคล่อง/อายุ pair), RugCheck, ตรวจ mint/freeze authority และสัดส่วน holder บนเชน |
| `src/agents.ts` | 6 เอเจนต์และการโหวต (เพิ่ม LLM ให้เอเจนต์ NARRATIVE ได้ เช่น xAI Grok ผ่าน `NARRATIVE_LLM_*`) |
| `src/jupiter.ts` | Jupiter Swap v2 |
| `src/engine.ts` | ขนาดไม้, เข้า/ออก, TP/SL/trailing, ขายตาม leader, สถิติ, บันทึกสถานะ |
| `src/index.ts` | เซิร์ฟเวอร์แดชบอร์ด (SSE) และลูปหลัก |
| `public/dashboard.html` | หน้าตาแบบในวิดีโอ (เปิดตรงๆ จะเป็นโหมดเดโม) |
| `src/supabase.ts` | ส่งสถานะ/ประวัติเทรดเข้า Supabase และรับคำสั่ง kill/resume |
| `supabase/schema.sql` | ตาราง + RLS + Realtime |
| `scripts/build-web.mjs`, `vercel.json` | build หน้าเว็บสำหรับ Vercel |
| `Dockerfile` | รันบอทบน VPS/Railway/Fly |

> ไม่ใช่คำแนะนำทางการเงิน การเทรดเหรียญมีมมีความเสี่ยงสูงมาก และคนส่วนใหญ่ขาดทุน
