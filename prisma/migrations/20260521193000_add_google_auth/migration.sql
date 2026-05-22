-- Add minimal login-only Google OAuth linkage and state storage.
ALTER TABLE "users"
  ADD COLUMN "googleId" TEXT,
  ADD COLUMN "isProfileComplete" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

CREATE TABLE "auth_oauth_states" (
  "id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,

  CONSTRAINT "auth_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_oauth_states_state_key" ON "auth_oauth_states"("state");
CREATE INDEX "auth_oauth_states_expiresAt_idx" ON "auth_oauth_states"("expiresAt");

ALTER TABLE "auth_oauth_states"
  ADD CONSTRAINT "auth_oauth_states_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
