// Actions for Namaz Times Islamabad.
//
// Data source: the Aladhan Prayer Times API (api.aladhan.com), fetched
// server-side for Islamabad's coordinates (33.7294, 73.0931) with
// method=1 (University of Islamic Sciences, Karachi — the standard
// Pakistan method) and school=1 (Hanafi Asr). Responses are cached per
// day / per month in `timings_cache`; a daily cron calls
// `refreshTimings` so the cache is warm, and any cache miss fetches live.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

const LAT = "33.7294";
const LON = "73.0931";
const API = "https://api.aladhan.com/v1";
const PARAMS = `latitude=${LAT}&longitude=${LON}&method=1&school=1`;

const dayTimings = z.object({
  date: z.string(), // YYYY-MM-DD (Gregorian, Asia/Karachi)
  gregorianLabel: z.string(), // "Monday, 26 October 2026"
  hijriLabel: z.string(), // "15 Jumada al-ula 1448 AH"
  fajr: z.string(), // "04:58" (24h, Asia/Karachi)
  sunrise: z.string(),
  dhuhr: z.string(),
  asr: z.string(),
  maghrib: z.string(),
  isha: z.string(),
});
type DayTimings = z.infer<typeof dayTimings>;

const todayResponse = z.object({
  day: dayTimings,
  fetchedAt: z.string(),
});
const monthResponse = z.object({
  days: z.array(dayTimings),
  fetchedAt: z.string(),
});
const refreshResponse = z.object({
  ok: z.literal(true),
  date: z.string(),
});

// --- Karachi date helpers -------------------------------------------------

function karachiYmd(now = new Date()): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const apiDate = (y: number, m: number, d: number) => `${pad(d)}-${pad(m)}-${y}`;

// --- Aladhan parsing --------------------------------------------------------

interface AladhanDay {
  timings: Record<string, string>;
  date: {
    gregorian: { date: string; weekday: { en: string }; month: { en: string }; year: string };
    hijri: { day: string; month: { en: string }; year: string };
  };
}

function cleanTime(raw: string | undefined): string {
  // Calendar endpoint returns "04:39 (PKT)"; the timings endpoint "04:39".
  return (raw ?? "").split(" ")[0] ?? "";
}

function parseDay(data: AladhanDay): DayTimings {
  const g = data.date.gregorian;
  const [dd = "", mm = "", yyyy = ""] = g.date.split("-");
  const h = data.date.hijri;
  return {
    date: `${yyyy}-${mm}-${dd}`,
    gregorianLabel: `${g.weekday.en}, ${Number(dd)} ${g.month.en} ${yyyy}`,
    hijriLabel: `${h.day} ${h.month.en} ${h.year} AH`,
    fajr: cleanTime(data.timings.Fajr),
    sunrise: cleanTime(data.timings.Sunrise),
    dhuhr: cleanTime(data.timings.Dhuhr),
    asr: cleanTime(data.timings.Asr),
    maghrib: cleanTime(data.timings.Maghrib),
    isha: cleanTime(data.timings.Isha),
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Aladhan API returned HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function fetchDayFromApi(y: number, m: number, d: number): Promise<DayTimings> {
  const json = (await fetchJson(
    `${API}/timings/${apiDate(y, m, d)}?${PARAMS}`,
  )) as { data: AladhanDay };
  return parseDay(json.data);
}

async function fetchMonthFromApi(y: number, m: number): Promise<DayTimings[]> {
  const json = (await fetchJson(
    `${API}/calendar/${y}/${m}?${PARAMS}`,
  )) as { data: AladhanDay[] };
  return json.data.map(parseDay);
}

// --- Cache ------------------------------------------------------------------

async function readCache<T>(ctx: Ctx, key: string): Promise<{ value: T; fetchedAt: Date } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.timingsCache)
    .where(eq(schema.timingsCache.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { value: JSON.parse(row.payload) as T, fetchedAt: row.fetchedAt };
}

async function writeCache(ctx: Ctx, key: string, value: unknown): Promise<void> {
  const db = ctx.db<typeof schema>();
  const payload = JSON.stringify(value);
  const now = new Date();
  await db
    .insert(schema.timingsCache)
    .values({ key, payload, fetchedAt: now })
    .onConflictDoUpdate({
      target: schema.timingsCache.key,
      set: { payload, fetchedAt: now },
    });
}

async function loadDay(
  ctx: Ctx,
  y: number,
  m: number,
  d: number,
  force: boolean,
): Promise<{ day: DayTimings; fetchedAt: string }> {
  const key = `day:${ymdKey(y, m, d)}`;
  if (!force) {
    const cached = await readCache<DayTimings>(ctx, key);
    if (cached) return { day: cached.value, fetchedAt: cached.fetchedAt.toISOString() };
  }
  const day = await fetchDayFromApi(y, m, d);
  await writeCache(ctx, key, day);
  return { day, fetchedAt: new Date().toISOString() };
}

async function loadMonth(
  ctx: Ctx,
  y: number,
  m: number,
  force: boolean,
): Promise<{ days: DayTimings[]; fetchedAt: string }> {
  const key = `month:${y}-${pad(m)}`;
  if (!force) {
    const cached = await readCache<DayTimings[]>(ctx, key);
    if (cached) return { days: cached.value, fetchedAt: cached.fetchedAt.toISOString() };
  }
  const days = await fetchMonthFromApi(y, m);
  await writeCache(ctx, key, days);
  return { days, fetchedAt: new Date().toISOString() };
}

// --- Actions ------------------------------------------------------------------

export const Actions = {
  getToday: defineAction({
    request: z.object({}),
    response: todayResponse,
    async handler(ctx): Promise<z.infer<typeof todayResponse>> {
      const { y, m, d } = karachiYmd();
      return loadDay(ctx, y, m, d, false);
    },
  }),

  getMonth: defineAction({
    request: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
    }),
    response: monthResponse,
    async handler(ctx, args): Promise<z.infer<typeof monthResponse>> {
      return loadMonth(ctx, args.year, args.month, false);
    },
  }),

  // Silent daily refresh target (cron) and the manual refresh button.
  refreshTimings: defineAction({
    request: z.object({ force: z.boolean().default(true) }),
    response: refreshResponse,
    async handler(ctx, args): Promise<z.infer<typeof refreshResponse>> {
      const { y, m, d } = karachiYmd();
      await loadDay(ctx, y, m, d, args.force);
      await loadMonth(ctx, y, m, args.force);
      ctx.invalidateQueries();
      return { ok: true as const, date: ymdKey(y, m, d) };
    },
  }),
} satisfies ActionsModule;
