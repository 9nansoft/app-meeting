# OpenThai2.0 ASR Streaming บน DGX Spark

server ถอดเสียงภาษาไทยด้วยโมเดล [iapp/OpenThai2.0-ASR-Streaming](https://huggingface.co/iapp/OpenThai2.0-ASR-Streaming)
(FastConformer + RNN-T 0.6B, NeMo) รันบน GPU ของ DGX Spark (arm64, CUDA 13) ด้วย Docker

## ต้องมีบนเครื่อง

- NVIDIA driver 580 ขึ้นไป, Docker + compose v2, NVIDIA Container Toolkit (DGX OS มีครบแล้ว)
- ผู้ใช้อยู่ในกลุ่ม `docker`
- พื้นที่ว่างประมาณ 30GB และต่ออินเทอร์เน็ตได้ (ดึง PyTorch, NeMo, โมเดลจาก Hugging Face)

## ติดตั้ง

คัดลอกโฟลเดอร์นี้ไปไว้บน DGX (เช่น `git clone` repo นี้ หรือ `scp -r deploy/asr-dgx dgx:~/openthai-asr`) แล้วรัน:

```bash
./install.sh --with-diarization
```

สคริปต์จะ:
1. ตรวจ driver, Docker, ว่า container มองเห็น GPU และดูพื้นที่ดิสก์
2. สร้าง `.env` ครั้งแรก (uid/gid, ที่อยู่ที่เปิดพอร์ต, commit ของโมเดลที่ pin ไว้)
3. build image: Python 3.12, PyTorch 2.13 cu130 และ NeMo commit `cf724ac` ตามที่ model card ทดสอบ (ครั้งแรกใช้เวลา 15-40 นาที)
4. ดาวน์โหลดไฟล์ `*_raw.nemo` และ `serve/` ไว้ที่ `data/model/`; ใส่ `--with-diarization` เพื่อดาวน์โหลดโมเดลแยกผู้พูดไว้ล่วงหน้าด้วย
5. เปิด server, รอโหลดโมเดล แล้วทดสอบ `/v1/health` และ `/v1/transcribe` บน GPU

รันซ้ำได้ ขั้นที่เสร็จแล้วไม่ทำให้เสียหาย

## ให้ app-meeting เรียกใช้

server ของ iApp **ไม่มี authentication และไม่มี rate limit** ค่าเริ่มต้นจึงเปิดเฉพาะ `127.0.0.1`

ถ้า app-meeting อยู่คนละเครื่อง ให้แก้ `ASR_BIND` ใน `.env` เป็น IP วงภายในหรือ Tailscale ของ DGX (ห้ามใช้ `0.0.0.0` ถ้าเครื่องออกอินเทอร์เน็ตตรง) แล้วรัน:

```bash
docker compose up -d
```

จากนั้นใส่ใน `.env` ของ app-meeting แล้ว restart แอป:

```bash
OPENTHAI_ASR_URL=http://<IP ของ DGX>:18081
```

ตัวเลือกอื่นอยู่ใน `.env.example` เช่น `OPENTHAI_ASR_MODE`, `OPENTHAI_ASR_LANG` และ `OPENTHAI_ASR_TOKEN`

| endpoint | ใช้กับ |
|---|---|
| `POST /v1/transcribe` | ไฟล์เสียง (multipart `file`, `mode`, `lang`, `latency_ms`) ใน app-meeting คือไฟล์ที่อัปโหลดเป็นช่วง ๆ |
| `WS /v1/live` | เสียงสด PCM16 16kHz mono ได้ `partial`/`final` กลับมาทันที |
| `GET /v1/health` | สถานะและค่าที่ตั้งไว้ |

ใช้ `mode=meeting` เพื่อได้ speaker labels (`speaker_0`, `speaker_1`, ...) ในผลจาก `/v1/transcribe`

## ดูแลระบบ

```bash
docker compose logs -f asr          # ดู log
docker compose restart asr          # รีสตาร์ต
docker compose down                 # หยุด
```

- **อัปเดตโมเดล:** แก้ `MODEL_REVISION` ใน `.env` เป็น commit ใหม่จาก Hugging Face แล้วรัน `./install.sh --skip-build`
- **รองรับหลายห้องพร้อมกัน:** เพิ่ม `CHINDA_REPLICAS` ใน `.env` (ใช้หน่วยความจำประมาณ 2.6GB ต่อสำเนา)
- **อัปเดต PyTorch/NeMo:** แก้ `ARG` ใน `Dockerfile` แล้วรัน `./install.sh` ใหม่

## License

ตัวโมเดลใช้ OpenMDW-1.1 (ดู `data/model/OpenThai2.0-ASR-Streaming/LICENSE`) ส่วน "Nemotron" เป็นเครื่องหมายการค้าของ NVIDIA
