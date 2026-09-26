# Nuxt + Elysia + Shadcn-Vue Full-Stack Showcase

This project is a comprehensive full-stack showcase demonstrating the seamless integration of Nuxt, ElysiaJS, and Shadcn-Vue, all powered by Bun.

## Features & Highlights

### 🎨 Frontend UI (Shadcn-Vue & Tailwind CSS v4)
- **40+ Components**: Fully installed and configured all components from `shadcn-vue`.
- **Theme Toggle**: Out-of-the-box Dark, Light, and System theme support using `@nuxtjs/color-mode`.
- **Advanced Layouts**: Integrated complex components like Data Tables, Calendars (with `DateValue` fixes), Dialogs, Carousel, and more into a categorized dynamic showcase.
- **Tailwind v4**: Properly configured to work alongside Vue SFCs using `@reference` directives.

### ⚙️ Backend API (ElysiaJS & Nuxt Nitro)
- **Nuxt-Elysia Integration**: Runs an ElysiaJS server directly within the Nuxt Nitro engine for a unified deployment.
- **Mock Database**: Set up an in-memory database to handle user records flexibly.
- **Authentication Routes**: Implemented secure Login, Registration, Logout, and User Session endpoints using HTTP-Only cookies.
- **CRUD Routes**: Fully structured REST endpoints for Creating, Reading, Updating, and Deleting user data.

### 🔗 End-to-End Type Safety (Eden Treaty)
- **Zero-Config Client**: Utilizes `@elysiajs/eden` to provide a fully typed `$api` fetch client directly within Nuxt plugins.
- **Interactive Auth Flow**: A functioning login/register component (`AuthShowcase.vue`) that sets cookies and resolves user profiles.
- **Interactive CRUD Dashboard**: A user management table (`UsersCrud.vue`) that instantly reflects backend database mutations through Eden calls.

---

## 🚀 Getting Started

Make sure to install dependencies using Bun (recommended for Nitro presets):

```bash
bun install
```

### Development Server

Start the development server on `http://localhost:3080` (or `3000` depending on port availability):

```bash
bun run dev
```

### Production Build

Build the application for production (using the Bun Nitro preset):

```bash
bun run build
```

Locally preview the production build:

```bash
bun run preview
```

## 🔐 Environment Variables

สร้างไฟล์ `.env` ที่ root ของโปรเจกต์ แล้วกำหนดค่าอย่างน้อยดังนี้:

PASETO_KEY=REPLACE_WITH_BASE64URL_32_BYTE_KEY

โปรเจกต์นี้ใช้ `paseto-ts/v4` และอ่าน `PASETO_KEY` เป็น **base64url** ก่อน decode กลับเป็น key 32 bytes สำหรับ `v4.local`

- `PASETO_KEY` ต้อง decode แล้วได้ **32 bytes พอดี**
- ถ้าไม่ใช่ 32 bytes จะเจอข้อผิดพลาด: `Invalid key. Key must be 32 bytes long.`
- ไม่ควรใส่ค่าแบบ `k4.local....` หากโค้ดฝั่งเซิร์ฟเวอร์คาดว่าเป็น base64url ของ raw key
- หลังแก้ `.env` ให้ restart เซิร์ฟเวอร์ และลบ cookie/session เดิมก่อนทดสอบล็อกอินใหม่

### Generate key ด้วย `paseto-ts`

ตัวอย่างสคริปต์สำหรับ generate key และพิมพ์เป็น base64url เพื่อนำไปใส่ `.env`:

```scripts/gen-paseto-key.ts
import { generateKeys } from 'paseto-ts/v4';

const localKey = generateKeys('local');
// localKey: k4.local.xxx..
```

รันแล้วนำค่าที่ได้ไปใส่ใน `.env`:
- `bun run gen:key` (หรือวิธีรัน TypeScript ที่คุณใช้ในโปรเจกต์)

## Gitlab CI/CD Prodction

```
เปลี่ยนชื่อไฟล์ .gitlab-ci.yml.prd ---> .gitlab-ci.yml
```

### สร้างโฟลเดอร์โปรเจกต์
```
mkdir -p ~/app-docker
cd ~/app-docker
mkdir cloudflared
```

### โครงสร้าง
```
app-docker/
├─ docker-compose.yml
├─ .env
└─ cloudflared/
   └─ (config หรือ credential จะถูกวางที่นี่)
```

### config docker-compose.yml

เปลี่ยนไปเป็น repo ของตัวเอง
exp repo: phingosoft/es-nuxt

```
image: "registry.gitlab.com/phingosoft/es-nuxt:latest"
```

### config cloudflare tunnel
```
mkdir cloudflared
```
---
Built with ❤️ using [Nuxt](https://nuxt.com/), [Elysia](https://elysiajs.com/), and [Shadcn-Vue](https://www.shadcn-vue.com/).
