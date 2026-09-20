import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  userId: text("user_id").primaryKey(), email: text("email").notNull(), displayName: text("display_name").notNull(),
  role: text("role").notNull(), status: text("status").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
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
