-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'WAITING_VERIFICATION', 'COMPLETED', 'REJECTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('CONFIRM_PROCESSING', 'ACCESS_DATA', 'CORRECT_DATA', 'DELETE_OR_ANONYMIZE', 'PORTABILITY', 'SHARING_INFORMATION', 'REVOKE_CONSENT', 'OTHER');

-- CreateEnum
CREATE TYPE "RequesterType" AS ENUM ('PATIENT', 'CLINIC_OWNER', 'CLINIC_STAFF', 'OTHER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_LOGIN_SUCCESS', 'USER_LOGIN_FAILURE', 'USER_LOGOUT', 'USER_REFRESH_TOKEN', 'USER_PASSWORD_CHANGED', 'USER_PASSWORD_RESET_REQUESTED', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'USER_ROLE_CHANGED', 'PRIVACY_REQUEST_CREATED', 'PRIVACY_REQUEST_STATUS_CHANGED', 'PRIVACY_REQUEST_RESPONDED', 'COOKIE_CONSENT_RECORDED', 'TERMS_ACCEPTED', 'APPOINTMENT_CREATED', 'APPOINTMENT_UPDATED', 'APPOINTMENT_CANCELED', 'APPOINTMENT_COMPLETED', 'PATIENT_CREATED', 'PATIENT_UPDATED', 'PATIENT_DELETED', 'CLINICAL_RECORD_CREATED', 'CLINICAL_RECORD_UPDATED', 'CLINICAL_RECORD_ACCESSED', 'CLINICAL_RECORD_LOCKED', 'CLINICAL_RECORD_DELETED', 'GOOGLE_CALENDAR_CONNECTED', 'GOOGLE_CALENDAR_DISCONNECTED', 'GOOGLE_CALENDAR_SYNCED', 'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_CHANGED', 'OTHER');

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "requestCode" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "requesterType" "RequesterType" NOT NULL,
    "clinicName" TEXT,
    "requestType" "PrivacyRequestType" NOT NULL,
    "description" TEXT NOT NULL,
    "identityConfirmationAccepted" BOOLEAN NOT NULL DEFAULT false,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" TEXT,
    "responseNotes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cookie_consent_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "categories" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cookie_consent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "privacyPolicyVersion" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "clinicId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_requestCode_key" ON "privacy_requests"("requestCode");

-- CreateIndex
CREATE INDEX "privacy_requests_status_idx" ON "privacy_requests"("status");

-- CreateIndex
CREATE INDEX "privacy_requests_requesterEmail_idx" ON "privacy_requests"("requesterEmail");

-- CreateIndex
CREATE INDEX "privacy_requests_createdAt_idx" ON "privacy_requests"("createdAt");

-- CreateIndex
CREATE INDEX "cookie_consent_logs_userId_idx" ON "cookie_consent_logs"("userId");

-- CreateIndex
CREATE INDEX "cookie_consent_logs_createdAt_idx" ON "cookie_consent_logs"("createdAt");

-- CreateIndex
CREATE INDEX "terms_acceptances_userId_idx" ON "terms_acceptances"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_idx" ON "audit_logs"("actorUserId");

-- CreateIndex
CREATE INDEX "audit_logs_clinicId_idx" ON "audit_logs"("clinicId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
