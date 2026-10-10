-- CreateTable
CREATE TABLE "cache_entries" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_entries_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "steps" (
    "id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "cache_key" TEXT,
    "status" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cache_entries_expires_at_idx" ON "cache_entries"("expires_at");

-- CreateIndex
CREATE INDEX "steps_run_id_created_at_idx" ON "steps"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "steps_tool_created_at_idx" ON "steps"("tool", "created_at");
