# ตั้งค่า AI วิเคราะห์ผล (Gemini + Cloudflare Worker)

ใช้ฟรีทั้งหมด ไม่ต้องผูกบัตร ทำครั้งเดียว ประมาณ 10 นาที

## ภาพรวม

```
ผู้เล่นเล่นจบ → หน้าเว็บ (GitHub Pages) → Cloudflare Worker (เก็บ key) → Google Gemini → กลับมาแสดงในหน้าผลลัพธ์
```

ผู้เล่นมองไม่เห็น API key เพราะ key อยู่ใน Cloudflare เท่านั้น

## ขั้นที่ 1: ขอ Gemini API key

1. เข้า https://aistudio.google.com แล้วล็อกอินด้วยบัญชี Google
2. กด **Get API key** → **Create API key**
3. คัดลอก key เก็บไว้ (ห้ามใส่ในไฟล์เว็บ ห้ามส่งในแชต)
4. **ห้ามผูกบัญชีชำระเงิน** จะได้อยู่ในโควตาฟรีเสมอ

## ขั้นที่ 2: สร้าง Worker

1. เข้า https://dash.cloudflare.com แล้วล็อกอิน
2. เมนูซ้ายเลือก **Workers & Pages** (หรือ **Compute → Workers**)
3. กด **Create** → เลือก **Start with Hello World!** (หรือ **Create Worker**)
4. ตั้งชื่อ เช่น `survimind-ai` แล้วกด **Deploy**
5. กด **Edit code**
6. ลบโค้ดเดิมทั้งหมด แล้ววางโค้ดจากไฟล์ `worker/worker.js` ใน repository นี้
7. กด **Deploy** มุมขวาบน

## ขั้นที่ 3: ใส่ API key

1. กลับไปหน้า Worker `survimind-ai`
2. แท็บ **Settings** → หัวข้อ **Variables and Secrets** → กด **Add**
3. Type เลือก **Secret**
4. Variable name: `GEMINI_API_KEY`
5. Value: วาง key จากขั้นที่ 1
6. กด **Deploy** (หรือ **Save**)

## ขั้นที่ 4: ทดสอบว่า Worker ทำงาน

เปิดลิงก์ Worker ในเบราว์เซอร์ (ดูได้ที่หน้า Worker เช่น `https://survimind-ai.ชื่อบัญชี.workers.dev`)
ถ้าขึ้น `{"ok":true,"service":"survimind-ai"}` แปลว่าพร้อมแล้ว

## ขั้นที่ 5: ส่งลิงก์ Worker ให้ Claude

ลิงก์ Worker ไม่ใช่ความลับ ส่งในแชตได้ Claude จะใส่ลิงก์นี้ในตัวแปร `AI_ENDPOINT` ใน `index.html` แล้วอัปโหลดขึ้น GitHub

## ตั้งค่าเพิ่มเติม (ไม่บังคับ)

| ตัวแปร | ใช้ทำอะไร | ค่าเริ่มต้น |
|---|---|---|
| `ALLOWED_ORIGINS` | เว็บที่อนุญาตให้เรียก Worker | `https://survimind.github.io` |
| `GEMINI_MODELS` | โมเดลที่ใช้ ลองตามลำดับ ถ้าตัวแรกเต็มจะใช้ตัวถัดไป | `gemini-3.5-flash-lite,gemini-3.8-flash` |

ถ้า Google เปลี่ยนชื่อโมเดลในอนาคต ให้ดูชื่อใหม่ใน Google AI Studio แล้วใส่ใน `GEMINI_MODELS`

## ความปลอดภัยและความเป็นส่วนตัว

- หน้าเว็บส่งเฉพาะคะแนนและพฤติกรรมการเล่น ไม่ส่งชื่อ รหัสนักศึกษา เพศ อายุ
- Worker สร้างคำสั่ง AI เอง จึงเอา Worker ไปใช้เป็นแชตบอตฟรีไม่ได้
- โควตาฟรีของ Gemini: Google อาจนำข้อมูลที่ส่งไปใช้พัฒนาผลิตภัณฑ์ จึงไม่ส่งข้อมูลส่วนตัวเด็ดขาด
- ถ้า AI ใช้ไม่ได้ (โควตาเต็ม เน็ตหลุด) หน้าเว็บจะแสดงผลแบบมาตรฐานแทน และมีปุ่มลองใหม่

## อัปเดตโค้ด Worker (เมื่อมีฟีเจอร์ใหม่ เช่น AI Coach)

1. Cloudflare → **Compute** → **Workers & Pages** → กด **survimind-ai**
2. กด **Edit code** (ไอคอน `</>` มุมขวาบน)
3. ลบโค้ดเดิมทั้งหมด วางโค้ดล่าสุดจาก `worker/worker.js` แล้วกด **Deploy**
4. ไม่ต้องใส่ API key ใหม่ key เดิมยังอยู่

## ให้ Worker อัปเดตเองอัตโนมัติจาก GitHub (ทำครั้งเดียว)

หลังตั้งค่านี้ ทุกครั้งที่ไฟล์ใน `worker/` บน GitHub เปลี่ยน Cloudflare จะ deploy ให้เอง ไม่ต้องคัดลอกโค้ดอีก

1. Cloudflare → **Compute** → **Workers & Pages** → กด **survimind-ai**
2. แท็บ **Settings** → หัวข้อ **Build** → กด **Connect** ที่ **Git repository**
3. เลือก **GitHub** แล้วอนุญาตให้ Cloudflare เข้าถึง repository `survimind/survimind`
4. ตั้งค่าดังนี้
   - Branch: `main`
   - Root directory (Path): `/worker`
   - Build command: เว้นว่าง
   - Deploy command: `npx wrangler deploy`
5. กด **Connect** แล้วรอ build แรกเสร็จ (เครื่องหมายถูกสีเขียว)

API key ไม่หาย เพราะเก็บเป็น Secret ใน Cloudflare แยกจากโค้ด
