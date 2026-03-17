-- CreateTable
CREATE TABLE "WaAuthCreds" (
    "sessionId" TEXT NOT NULL,
    "creds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthCreds_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "WaAuthKey" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "value" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaAuthKey_sessionId_category_keyId_idx" ON "WaAuthKey"("sessionId", "category", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "WaAuthKey_sessionId_category_keyId_key" ON "WaAuthKey"("sessionId", "category", "keyId");
