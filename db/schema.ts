import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  updatedAt: text("updated_at").notNull(), updatedBy: text("updated_by").notNull(),
});
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
]);
