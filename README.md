# STAX

ระบบจัดการพอร์ตหุ้นจาก Statement — นำเข้าไฟล์ Statement (PDF) แล้วสกัดธุรกรรมอัตโนมัติ
ลงบัญชีแยกประเภทแบบคู่ (double-entry) พร้อมหน้าสรุป เงินเข้า-ออก สมุดบันทึกการซื้อขาย
รายละเอียดหุ้นรายตัว และคลังเอกสาร

> เอกสารนี้อธิบายภาพรวมโปรเจกต์ ฟีเจอร์ที่ทำแล้ว และวิธีรันงาน
> ส่วนงานที่ต้องประสานต่อ กรุณาติดต่อเจ้าของโปรเจกต์โดยตรง

## Tech Stack

| ส่วน | เทคโนโลยี |
| --- | --- |
| Framework | React Router 8 (SSR), React 19, TypeScript |
| UI | TailwindCSS 4, lucide-react, recharts |
| Database | Postgres + Drizzle ORM |
| Storage | Supabase Storage (ไฟล์ PDF), fallback local |
| AI | Gemini (preview/วิเคราะห์ Statement — แสดงผลเท่านั้น ไม่เขียน DB) |
| ตัวเลขการเงิน | decimal.js (ไม่ใช้ float กับเงิน) |

## ฟีเจอร์ที่ทำแล้ว

- **Auth** — สมัคร/ล็อกอิน (USER/ADMIN), session ด้วย JWT, เปิด-ปิดบัญชี (suspend) ฝั่ง admin
- **นำเข้า Statement** — ดูตัวอย่างก่อนกดยืนยัน (preview-then-commit), กันไฟล์ซ้ำด้วย content hash,
  นำเข้าซ้ำหลังลบข้อมูลได้โดยไม่สร้างแถวซ้ำ, ต้นทุนแบบ Webull Average Cost (ไม่รวมค่าธรรมเนียม)
- **บัญชีแยกประเภท (GL)** — ผังบัญชี, สมุดรายวัน, กลับรายการ, งบทดลอง/งบกำไรขาดทุน/งบดุล
  (แสดงทั้งสกุลเดิมและฐานบาท), บันทึกรายการด้วยมือ
- **สมุดบันทึกการซื้อขาย** — ฟิลเตอร์วันที่/หุ้น/ประเภท, โน้ตนักลงทุนรายรายการ, แบ่งหน้า 20 รายการ,
  การ์ดสรุปหุ้นที่ถืออยู่พร้อมต้นทุนเฉลี่ย
- **เงินเข้า-ออก** — ภาพรวม/รายเดือน/ตัดยอด ณ วันที่, ส่วนแลกเปลี่ยนสกุลเงินพร้อมเปรียบเทียบทิศทาง (เข้า-ออกบาท)
- **คลัง Statement** — จัดกลุ่มตามเดือน, ดูธุรกรรมของแต่ละไฟล์, ดาวน์โหลด PDF ของตัวเอง
- **รายละเอียดหุ้นรายตัว** — ประวัติซื้อขาย + การถือครอง + ราคาปิดรายวัน + กำไรที่รับรู้แล้ว
- **หน้าหลัก** — สรุปงบ การถือครอง ฐานภาษี เอกสาร และธุรกรรมล่าสุด
- **ราคาหุ้นรายวัน** — ดึงราคาปิดอัตโนมัติ (cron) แสดงมูลค่าตลาดแบบ display-only
- **Admin** — จัดการผู้ใช้, สถิติ, เอกสารทั้งหมด, ประวัติกิจกรรม
- **ค้นหา** — ทุกฟีเจอร์ที่มีรายการมีช่องค้นหา (กรองฝั่งหน้าบ้าน ไม่แตะ backend)

หลักการสำคัญ: ตัวเลขการเงินทั้งหมดคำนวณฝั่ง server หน้าบ้านแสดงค่าตามที่ server ส่งมาเท่านั้น
(ไม่คำนวณ P&L/FX ใหม่ใน React)

## วิธีรัน

```bash
npm install
cp .env.example .env   # แล้วกรอกค่าจริง (ดูตารางด้านล่าง)
npm run db:migrate
npm run dev            # http://localhost:5173
```

Production:

```bash
npm run build
npm start
```

## Environment Variables

| ตัวแปร | ใช้ทำอะไร |
| --- | --- |
| `DATABASE_URL` | connection string Postgres |
| `JWT_SECRET` | เซ็น/ตรวจ session token (server-only) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` | เก็บไฟล์ PDF (server-only) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | วิเคราะห์ Statement (server-only) |
| `CRON_SECRET` | ป้องกัน endpoint refresh ราคาหุ้นรายวัน |

ดูตัวอย่างทั้งหมดใน `.env.example` ห้าม commit ไฟล์ `.env` จริงขึ้น repo เด็ดขาด

## คำสั่งที่ควรรู้

```bash
npm test          # unit/integration tests ทั้งหมด (ไม่ต้องใช้ DB จริง)
npm run test:w2   # regression ฝั่ง DB — ต้องตั้ง TEST_DATABASE_URL ก่อน
npm run typecheck # ตรวจ TypeScript
npm run db:studio # เปิดดูฐานข้อมูล
```

## โครงสร้าง repo

```
app/
  routes/api/        # API endpoints (/api/v1/...)
  lib/               # business logic (parser, pipeline, GL engine, providers)
  component/         # หน้าจอ (DashboardUser, Ledger, LedgerRedesign, Journal, Admin)
  db/schema.ts       # Drizzle schema
drizzle/             # migration files
scripts/             # tests (*.mts) + one-shot backfill/repair scripts
```

งานค้าง/งานซ่อมแบบ one-shot อยู่ใน `scripts/` (ชื่อขึ้นต้น `backfill-`, `recompute-`, `swap-`, `restore-`)
แต่ละไฟล์มีวิธีใช้ในคอมเมนต์ด้านบนของไฟล์
