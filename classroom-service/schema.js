import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
export const classes = sqliteTable('classes', {
  code: text('code').primaryKey(), ownerId: text('owner_id').notNull(), assignmentJson: text('assignment_json').notNull(),
  expiresAt: integer('expires_at').notNull(), requestId: text('request_id').notNull(), payloadHash: text('payload_hash').notNull(),
}, table => [uniqueIndex('classes_owner_request').on(table.ownerId, table.requestId), index('classes_expiry').on(table.expiresAt)]);
export const members = sqliteTable('members', {
  id: text('id').primaryKey(), code: text('code').notNull().references(() => classes.code, { onDelete: 'cascade' }),
  alias: text('alias').notNull(), aliasKey: text('alias_key').notNull(), tokenHash: text('token_hash').notNull(),
  requestId: text('request_id').notNull(), payloadHash: text('payload_hash').notNull(),
}, table => [uniqueIndex('members_alias').on(table.code, table.aliasKey), uniqueIndex('members_token').on(table.tokenHash), uniqueIndex('members_request').on(table.code, table.requestId)]);
export const runs = sqliteTable('runs', {
  id: text('id').notNull(), memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  payloadHash: text('payload_hash').notNull(), mistakes: integer('mistakes'), elapsedMs: integer('elapsed_ms'),
  reason: text('reason'), submittedAt: integer('submitted_at').notNull(),
}, table => [primaryKey({ columns: [table.memberId, table.id] }), index('runs_member_score').on(table.memberId, table.mistakes, table.elapsedMs)]);
