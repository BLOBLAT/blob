CREATE TYPE "ArenaChatMessageStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'REMOVED');

CREATE TABLE "ArenaChatMessageAudit" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "matchId" TEXT,
    "roundId" TEXT,
    "profileUserId" TEXT,
    "anonymousAuthorKey" TEXT,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "ArenaChatMessageStatus" NOT NULL DEFAULT 'VISIBLE',
    "sentAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArenaChatMessageAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArenaChatMessageAudit_author_identity_check" CHECK (
      ("profileUserId" IS NULL) <> ("anonymousAuthorKey" IS NULL)
    )
);

CREATE INDEX "ArenaChatMessageAudit_roomId_sentAt_idx" ON "ArenaChatMessageAudit"("roomId", "sentAt");
CREATE INDEX "ArenaChatMessageAudit_matchId_roundId_sentAt_idx" ON "ArenaChatMessageAudit"("matchId", "roundId", "sentAt");
CREATE INDEX "ArenaChatMessageAudit_profileUserId_sentAt_idx" ON "ArenaChatMessageAudit"("profileUserId", "sentAt");
CREATE INDEX "ArenaChatMessageAudit_expiresAt_idx" ON "ArenaChatMessageAudit"("expiresAt");

ALTER TABLE "ArenaChatMessageAudit" ADD CONSTRAINT "ArenaChatMessageAudit_profileUserId_fkey"
  FOREIGN KEY ("profileUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
