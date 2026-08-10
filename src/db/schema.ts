import { pgTable, serial, text, integer, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

export const emailMetrics = pgTable('email_metrics', {
  id: serial('id').primaryKey(),
  metricType: text('metric_type').notNull(),
  value: integer('value').notNull(),
  previousValue: integer('previous_value').notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  metadata: jsonb('metadata'),
});

export const emailEvents = pgTable('email_events', {
  id: serial('id').primaryKey(),
  gmailMessageId: text('gmail_message_id').unique(),
  type: text('type').notNull(),
  subject: text('subject'),
  fromEmail: text('from_email'),
  toEmail: text('to_email'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  label: text('label'),
  isRead: boolean('is_read').default(false),
  hasAttachment: boolean('has_attachment').default(false),
  campaign: text('campaign'),
  mailSuiteStatus: text('mailsuite_status'),
});

export const labels = pgTable('labels', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  count: integer('count').notNull(),
  color: text('color'),
});

// Single-row table holding your Gmail refresh token, so the cron job can
// get a fresh access token without a browser session present.
export const gmailAuth = pgTable('gmail_auth', {
  id: serial('id').primaryKey(),
  refreshToken: text('refresh_token').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});