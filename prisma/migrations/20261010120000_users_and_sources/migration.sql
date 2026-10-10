-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('PRIMARY', 'REGULATOR', 'COMPANY', 'REFERENCE', 'NEWS', 'AI_OVERVIEW');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "image_url" TEXT,
    "clerk_updated_at" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "base_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "publisher" TEXT,
    "title" TEXT,
    "excerpt" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "legal_name_matched" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "sources_run_id_idx" ON "sources"("run_id");

-- CreateIndex
CREATE INDEX "sources_content_hash_idx" ON "sources"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sources_run_id_url_key" ON "sources"("run_id", "url");

