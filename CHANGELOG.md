# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **ระบบ Log ตาม พ.ร.บ. คอมพิวเตอร์**: ตาราง `security_logs` บันทึกข้อมูลจราจรคอมพิวเตอร์ตาม พ.ร.บ. การกระทำความผิดเกี่ยวกับคอมพิวเตอร์ (ฉบับที่ 2) พ.ศ. 2560 ม.26 — เหตุการณ์ login สำเร็จ/ไม่สำเร็จ, logout, session ไม่ถูกต้อง, การเข้าถึงไม่ได้รับอนุญาต (401/403), สมัครบัญชี, และ access log ทุก request พร้อม IP/User-Agent/เวลา/สถานะ/ระยะเวลา
- **Hash chain กันแก้ไข log**: ทุกแถวผูก `entry_hash` (SHA-256) กับแถวก่อนหน้า ตรวจจับการแก้ไข/ลบ log ภายหลังได้ — ตรวจอัตโนมัติทุกชั่วโมง + API ตรวจด้วยมือ
- **Retention บังคับขั้นต่ำ 90 วันตามกฎหมาย**: ลบ log หมดอายุรายวันโดยใช้ค่าไม่ต่ำกว่า 90 วันเสมอ (ตั้งต่ำกว่านี้ผ่าน API ไม่ได้)
- **หน้า "Log ระบบ" สำหรับแอดมิน** (`/admin/logs`): กรอง/ค้นหา log, สถิติ login ไม่สำเร็จราย IP/บัญชี, ปุ่มตรวจ integrity, ส่งออก CSV (UTF-8 BOM เปิดใน Excel ภาษาไทยได้) — การส่งออกถูกบันทึกใน log ด้วย
- **API ใหม่**: `GET /admin/security-logs` (กรอง/แบ่งหน้า), `GET /admin/security-logs/stats`, `GET /admin/security-logs/verify`, `GET /admin/security-logs/export` (admin เท่านั้น)
- ดึง IP ผู้เรียกจริงจาก `X-Forwarded-For` / `X-Real-IP` รองรับการอยู่หลัง reverse proxy

## [1.0.0] - 2026-02-22

### Added
- **Core Framework**: Initialized Nuxt 4 production-ready environment running on Bun Nitro preset.
- **UI System**: Fully integrated `shadcn-vue` containing 40+ accessible UI components.
- **Styling**: Configured advanced styling using Tailwind CSS v4 and `lucide-vue-next` icons.
- **Theming**: Implemented Dark, Light, and System theme toggles utilizing `@nuxtjs/color-mode`.
- **Showcase View**: Developed a comprehensive index page categorizing and displaying all UI components (Buttons, Forms, Overlays, Data Display, Advanced Interactions).
- **Backend API**: Embedded ElysiaJS directly into the Nuxt application via `nuxt-elysia`.
- **Authentication**: Created secure HTTP-Only session cookie-based Login, Registration, and Logout flows.
- **CRUD Operations**: Built an in-memory database with full REST endpoints for managing generic user models.
- **End-to-End Type Safety**: Wired the frontend to the backend using Eden Treaty for seamless `$api` calls.
- **Interactive Dashboards**: Developed `AuthShowcase.vue` and `UsersCrud.vue` to demonstrate full-stack capabilities in real-time.

### Fixed
- Addressed `shadcn-vue` namespace export mismatches (`InputOTP` and `PaginationContent`).
- Resolved circular dependency warnings internally within the `Calendar` sub-components.
- Fixed an issue where the `Calendar` component was unclickable by strictly typing its reactive state to `@internationalized/date` `DateValue`.
- Handled Nitro duplicate plugin injection conflicts originating from `nuxt-elysia`'s auto-imported Eden client.
