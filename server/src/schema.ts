// Drizzle schema for this space.
//
// One table: a small JSON cache of Aladhan API responses, keyed by
// `day:YYYY-MM-DD` or `month:YYYY-MM`. Prayer times change daily and are
// fetched live from api.aladhan.com on cache miss, so this table is a
// warm cache, not user data.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const timingsCache = sqliteTable("timings_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
