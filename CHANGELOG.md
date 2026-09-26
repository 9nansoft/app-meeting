# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
