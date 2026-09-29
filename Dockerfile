# ── Stage 1: Install dependencies ──
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install

# ── Stage 2: Build the Nuxt app ──
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ── Stage 3: Production runner ──
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# tesseract + ภาษาไทย/อังกฤษ สำหรับ OCR ไฟล์ PDF สแกน (fallback อัตโนมัติของระบบ)
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

# Copy only the Nitro output (self-contained server)
COPY --from=builder /app/.output ./.output

EXPOSE 3080
CMD ["bun", ".output/server/index.mjs"]