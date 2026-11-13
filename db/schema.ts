import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  userId: text("user_id").primaryKey(), username: text("username").notNull().default(""), email: text("email").notNull(), displayName: text("display_name").notNull(),
  phone: text("phone").notNull().default(""), organization: text("organization").notNull().default(""), position: text("position").notNull().default(""),
  role: text("role").notNull(), status: text("status").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("members_username_unique").on(table.username),
  uniqueIndex("one_active_admin").on(table.role).where(sql`${table.role} = 'admin' AND ${table.status} = 'active'`),
]);
export const workspaceStates = sqliteTable("workspace_states", {
  id: integer("id").primaryKey(), data: text("data").notNull(), version: integer("version").notNull(),
  updatedAt: text("updated_at").notNull(), updatedBy: text("updated_by").notNull(), writeNonce: text("write_nonce"),
});
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(), activityId: text("activity_id").notNull(), position: integer("position").notNull(), data: text("data").notNull(),
}, (table) => [index("meetings_activity_idx").on(table.activityId)]);
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }), actorId: text("actor_id").notNull(), action: text("action").notNull(),
  entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), createdAt: text("created_at").notNull(),
});
export const adminCredentials = sqliteTable("admin_credentials", {
  userId: text("user_id").primaryKey().references(() => members.userId),
  passwordHash: text("password_hash").notNull(), salt: text("salt").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const adminSessions = sqliteTable("admin_sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: text("user_id").notNull().references(() => members.userId), expiresAt: integer("expires_at").notNull(),
});
export const authAttempts = sqliteTable("auth_attempts", {
  key: text("key").primaryKey(), attempts: integer("attempts").notNull(), windowStart: integer("window_start").notNull(),
});
export const passwordResetRequests = sqliteTable("password_reset_requests", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => members.userId),
  status: text("status").notNull(),
  requestedAt: text("requested_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
});

export const registrationForms = sqliteTable("registration_forms", {
  id: text("id").primaryKey(),
  activityId: text("activity_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  schemaJson: text("schema_json").notNull(),
  privacyNotice: text("privacy_notice").notNull(),
  version: integer("version").notNull(),
  createdBy: text("created_by").notNull().references(() => members.userId),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("registration_forms_activity_unique").on(table.activityId),
  uniqueIndex("registration_forms_slug_unique").on(table.slug),
]);

export const registrationSubmissions = sqliteTable("registration_submissions", {
  id: text("id").primaryKey(),
  formId: text("form_id").notNull().references(() => registrationForms.id),
  formVersion: integer("form_version").notNull(),
  schemaJson: text("schema_json").notNull(),
  answersJson: text("answers_json").notNull(),
  consent: integer("consent", { mode: "boolean" }).notNull(),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentNote: text("payment_note").notNull().default(""),
  reminderFiveDaysSentAt: text("reminder_5d_sent_at"),
  reminderOneDaySentAt: text("reminder_1d_sent_at"),
  idempotencyHash: text("idempotency_hash").notNull(),
  sourceHash: text("source_hash").notNull(),
  submittedAt: text("submitted_at").notNull(),
}, (table) => [
  index("registration_submissions_form_idx").on(table.formId),
  uniqueIndex("registration_submissions_idempotency_unique").on(table.formId, table.idempotencyHash),
  uniqueIndex("registration_submissions_id_form_unique").on(table.id, table.formId),
]);

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("participants_google_sub_unique").on(table.googleSub),
]);

export const participantSessions = sqliteTable("participant_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  participantId: text("participant_id").notNull().references(() => participants.id),
  expiresAt: integer("expires_at").notNull(),
  consentEpoch: integer("consent_epoch"),
}, (table) => [
  index("participant_sessions_participant_idx").on(table.participantId),
]);

export const participantOauthTransactions = sqliteTable("participant_oauth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  bindingHash: text("binding_hash").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  returnPath: text("return_path").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("participant_oauth_transactions_expiry_idx").on(table.expiresAt),
]);

export const participantConsents = sqliteTable("participant_consents", {
  id: text("id").primaryKey(),
  participantId: text("participant_id").notNull().references(() => participants.id),
  version: text("version").notNull(),
  acceptedAt: text("accepted_at").notNull(),
}, (table) => [
  index("participant_consents_participant_idx").on(table.participantId),
]);

export const participantTerms = sqliteTable("participant_terms", {
  version: text("version").primaryKey(),
  content: text("content").notNull(),
}, (table) => [
  check("participant_terms_version_nonempty", sql`length(trim(${table.version})) > 0`),
  check("participant_terms_content_nonempty", sql`length(trim(${table.content})) > 0`),
]);

export const participantTermsCurrent = sqliteTable("participant_terms_current", {
  id: integer("id").primaryKey(),
  version: text("version").notNull().references(() => participantTerms.version),
}, (table) => [
  check("participant_terms_current_singleton", sql`${table.id} = 1`),
]);

export const participantConsentState = sqliteTable("participant_consent_state", {
  participantId: text("participant_id").primaryKey().references(() => participants.id),
  status: text("status").notNull(),
  epoch: integer("epoch").notNull(),
  termsVersion: text("terms_version").notNull().references(() => participantTerms.version),
}, (table) => [
  check("participant_consent_state_status", sql`${table.status} IN ('active', 'revoked')`),
  check("participant_consent_state_epoch", sql`${table.epoch} >= 1`),
]);

export const participantPendingIdentities = sqliteTable("participant_pending_identities", {
  tokenHash: text("token_hash").primaryKey(),
  googleSub: text("google_sub").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  termsVersion: text("terms_version").notNull().references(() => participantTerms.version),
  expiresAt: integer("expires_at").notNull(),
  claim: text("claim"),
}, (table) => [
  index("participant_pending_identities_expiry_idx").on(table.expiresAt),
  uniqueIndex("participant_pending_identities_claim_unique").on(table.claim).where(sql`${table.claim} IS NOT NULL`),
]);

export const registrationIdentities = sqliteTable("registration_identities", {
  submissionId: text("submission_id").primaryKey(),
  formId: text("form_id").notNull(),
  memberId: text("member_id").references(() => members.userId),
  participantId: text("participant_id").references(() => participants.id),
  status: text("status").notNull().default("active"),
}, (table) => [
  foreignKey({
    columns: [table.submissionId, table.formId],
    foreignColumns: [registrationSubmissions.id, registrationSubmissions.formId],
    name: "registration_identities_submission_form_fk",
  }),
  check("registration_identities_one_identity", sql`(${table.memberId} IS NOT NULL) <> (${table.participantId} IS NOT NULL)`),
  check("registration_identities_valid_status", sql`${table.status} IN ('active', 'cancelled')`),
  uniqueIndex("registration_identities_form_member_unique").on(table.formId, table.memberId).where(sql`${table.memberId} IS NOT NULL AND ${table.status} = 'active'`),
  uniqueIndex("registration_identities_form_participant_unique").on(table.formId, table.participantId).where(sql`${table.participantId} IS NOT NULL AND ${table.status} = 'active'`),
]);

export const registrationQrTokens = sqliteTable("registration_qr_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  submissionId: text("submission_id").notNull().references(() => registrationSubmissions.id),
  issuedAt: integer("issued_at").notNull(),
  revokedAt: integer("revoked_at"),
}, (table) => [
  index("registration_qr_tokens_submission_idx").on(table.submissionId),
]);
