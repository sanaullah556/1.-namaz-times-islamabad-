import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Day = ApiResponse<typeof api, "getToday">["day"];

const PRAYERS = [
  { key: "fajr", en: "Fajr", ur: "فجر" },
  { key: "sunrise", en: "Sunrise", ur: "طلوعِ آفتاب" },
  { key: "dhuhr", en: "Dhuhr", ur: "ظہر" },
  { key: "asr", en: "Asr", ur: "عصر" },
  { key: "maghrib", en: "Maghrib", ur: "مغرب" },
  { key: "isha", en: "Isha", ur: "عشاء" },
] as const;
type PrayerKey = (typeof PRAYERS)[number]["key"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmt12(t: string): string {
  const [hRaw = 0, mRaw = 0] = t.split(":").map(Number);
  const suffix = hRaw >= 12 ? "PM" : "AM";
  const hh = hRaw % 12 === 0 ? 12 : hRaw % 12;
  return `${hh}:${String(mRaw).padStart(2, "0")} ${suffix}`;
}

function toMinutes(t: string): number {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Current wall-clock in Asia/Karachi, regardless of the viewer's timezone. */
function karachiClock(d: Date): { h: number; m: number; s: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    h: Number(get("hour")) % 24,
    m: Number(get("minute")),
    s: Number(get("second")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

interface NextInfo {
  index: number; // index into PRAYERS; PRAYERS.length means tomorrow's Fajr
  countdownSec: number;
  progress: number; // 0..1 through the current prayer period
}

function computeNext(day: Day, clock: { h: number; m: number; s: number }): NextInfo {
  const times = PRAYERS.map((p) => toMinutes(day[p.key]));
  const nowMin = clock.h * 60 + clock.m;
  const nowSec = nowMin * 60 + clock.s;

  let idx = times.findIndex((t) => t > nowMin);
  let targetMin: number;
  let startMin: number;
  if (idx === -1) {
    // All of today's prayers have passed — next is tomorrow's Fajr.
    idx = times.length;
    targetMin = (times[0] ?? 0) + 1440;
    startMin = times[times.length - 1] ?? 0;
  } else if (idx === 0) {
    targetMin = times[0] ?? 0;
    startMin = (times[times.length - 1] ?? 0) - 1440; // yesterday's Isha
  } else {
    targetMin = times[idx] ?? 0;
    startMin = times[idx - 1] ?? 0;
  }
  const span = targetMin - startMin;
  const elapsed = nowMin - startMin;
  return {
    index: idx,
    countdownSec: Math.max(0, targetMin * 60 - nowSec),
    progress: span > 0 ? Math.min(1, Math.max(0, elapsed / span)) : 0,
  };
}

function fmtCountdown(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function App() {
  const queryClient = useQueryClient();
  const now = useNow();
  const clock = karachiClock(now);

  const today = useQuery({
    queryKey: ["today"],
    queryFn: () => api.getToday({}),
  });

  // If the page stays open across midnight in Karachi, refetch the new day.
  const lastDayRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastDayRef.current && lastDayRef.current !== clock.ymd) {
      void queryClient.invalidateQueries({ queryKey: ["today"] });
      void queryClient.invalidateQueries({ queryKey: ["month"] });
    }
    lastDayRef.current = clock.ymd;
  }, [clock.ymd, queryClient]);

  const refresh = useMutation({
    mutationFn: () => api.refreshTimings({ force: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["today"] });
      void queryClient.invalidateQueries({ queryKey: ["month"] });
    },
  });

  const day = today.data?.day;
  const next = useMemo(() => (day ? computeNext(day, clock) : null), [day, clock]);

  const [monthOpen, setMonthOpen] = useState(false);
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);
  useEffect(() => {
    if (day && !cursor) {
      const [y = 2026, m = 1] = day.date.split("-").map(Number);
      setCursor({ y, m });
    }
  }, [day, cursor]);

  const month = useQuery({
    queryKey: ["month", cursor?.y, cursor?.m],
    queryFn: () => api.getMonth({ year: cursor?.y ?? 2026, month: cursor?.m ?? 1 }),
    enabled: monthOpen && cursor != null,
  });

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      if (!c) return c;
      const total = c.y * 12 + (c.m - 1) + delta;
      return { y: Math.floor(total / 12), m: (total % 12) + 1 };
    });
  };

  const nextPrayer =
    next && next.index < PRAYERS.length ? PRAYERS[next.index] : PRAYERS[0];
  const currentPrayer =
    next && next.index > 0 && next.index <= PRAYERS.length
      ? PRAYERS[next.index - 1]
      : PRAYERS[PRAYERS.length - 1];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--hero)" />

      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        {/* Date header */}
        <header className="pt-6 pb-5">
          <p className="text-sm font-medium tracking-wide text-[var(--gold)]">
            ISLAMABAD · PAKISTAN
          </p>
          <h1 className="font-display mt-1 text-3xl leading-tight">
            {day ? day.gregorianLabel : "Prayer times"}
          </h1>
          <p className="mt-1 text-base text-[var(--dim)]">
            {day ? day.hijriLabel : "Loading today's times…"}
          </p>
        </header>

        {today.isPending && (
          <p className="py-10 text-center text-[var(--dim)]">
            Loading prayer times…
          </p>
        )}

        {today.isError && (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
            <p className="text-base">
              Times could not be loaded. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => void today.refetch()}
              className="mt-4 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-text)]"
            >
              Try again
            </button>
          </div>
        )}

        {day && next && nextPrayer && currentPrayer && (
          <>
            {/* Hero: next prayer + countdown */}
            <section
              aria-label="Next prayer"
              className="rounded-[var(--radius)] bg-[var(--hero)] px-5 py-6 text-[var(--hero-text)]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium tracking-wide text-[var(--hero-dim)]">
                  NEXT PRAYER
                </p>
                <p className="text-sm text-[var(--hero-dim)]">
                  Now: {currentPrayer.en}
                </p>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="font-display text-5xl leading-none">
                  {nextPrayer.en}
                </h2>
                <span className="font-display text-3xl leading-none" lang="ur" dir="rtl">
                  {nextPrayer.ur}
                </span>
                <span className="text-xl text-[var(--hero-dim)]">
                  at {fmt12(day[nextPrayer.key])}
                  {next.index >= PRAYERS.length ? " (tomorrow)" : ""}
                </span>
              </div>
              <p
                className="font-display mt-4 text-6xl leading-none tabular-nums"
                aria-label={`Time remaining ${fmtCountdown(next.countdownSec)}`}
              >
                {fmtCountdown(next.countdownSec)}
              </p>
              <div
                className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/15"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(next.progress * 100)}
                aria-label="Time elapsed in the current prayer period"
              >
                <div
                  className="h-full rounded-full bg-[var(--gold)]"
                  style={{ width: `${Math.round(next.progress * 100)}%` }}
                />
              </div>
            </section>

            {/* Today's timetable */}
            <section aria-label="Today's prayer timetable" className="mt-6">
              <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {PRAYERS.map((p, i) => {
                  const isNext =
                    next.index === i ||
                    (next.index >= PRAYERS.length && i === 0);
                  const isCurrent =
                    next.index - 1 === i ||
                    (next.index === 0 && i === PRAYERS.length - 1);
                  const passed = next.index !== 0 && i < next.index - 1;
                  return (
                    <div
                      key={p.key}
                      className={`flex items-center gap-3 px-4 py-3.5 ${
                        i > 0 ? "border-t border-[var(--border)]" : ""
                      } ${isNext ? "bg-[var(--gold-soft)]" : ""}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline gap-2">
                          <span className="font-display text-lg">{p.en}</span>
                          <span className="text-base text-[var(--dim)]" lang="ur" dir="rtl">
                            {p.ur}
                          </span>
                        </p>
                      </div>
                      {isNext && (
                        <span className="rounded-full bg-[var(--gold)] px-2.5 py-0.5 text-xs font-bold text-white">
                          NEXT
                        </span>
                      )}
                      {isCurrent && (
                        <span className="rounded-full border border-[var(--gold)] px-2.5 py-0.5 text-xs font-bold text-[var(--gold)]">
                          NOW
                        </span>
                      )}
                      <p
                        className={`font-display text-xl tabular-nums ${
                          passed ? "text-[var(--dim)]" : ""
                        }`}
                      >
                        {fmt12(day[p.key])}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Actions */}
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-text)] disabled:opacity-60"
              >
                {refresh.isPending ? "Refreshing…" : "Refresh times"}
              </button>
              <button
                type="button"
                onClick={() => setMonthOpen((o) => !o)}
                aria-expanded={monthOpen}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold"
              >
                {monthOpen ? "Hide monthly timetable" : "Monthly timetable"}
              </button>
            </div>
            {refresh.isError && (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Refresh failed — the times below are the most recent ones loaded.
              </p>
            )}

            {/* Monthly timetable */}
            {monthOpen && cursor && (
              <section aria-label="Monthly timetable" className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    aria-label="Previous month"
                    onClick={() => shiftMonth(-1)}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-base font-semibold"
                  >
                    ‹
                  </button>
                  <h3 className="font-display text-xl">
                    {MONTH_NAMES[cursor.m - 1]} {cursor.y}
                  </h3>
                  <button
                    type="button"
                    aria-label="Next month"
                    onClick={() => shiftMonth(1)}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-base font-semibold"
                  >
                    ›
                  </button>
                </div>

                {month.isPending && (
                  <p className="py-8 text-center text-[var(--dim)]">
                    Loading the month…
                  </p>
                )}
                {month.isError && (
                  <div className="py-6 text-center">
                    <p className="text-[var(--dim)]">
                      This month could not be loaded.
                    </p>
                    <button
                      type="button"
                      onClick={() => void month.refetch()}
                      className="mt-3 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[var(--accent-text)]"
                    >
                      Try again
                    </button>
                  </div>
                )}
                {month.data && (
                  <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                    {month.data.days.map((d, i) => {
                      const isTodayRow = d.date === day.date;
                      const dom = Number(d.date.split("-")[2] ?? "0");
                      return (
                        <div
                          key={d.date}
                          className={`px-4 py-3 ${
                            i > 0 ? "border-t border-[var(--border)]" : ""
                          } ${isTodayRow ? "bg-[var(--gold-soft)]" : ""}`}
                        >
                          <p className="flex items-baseline justify-between gap-2">
                            <span className="font-display text-base">
                              {d.gregorianLabel.split(",")[0]}, {dom}{" "}
                              {MONTH_NAMES[cursor.m - 1]?.slice(0, 3)}
                              {isTodayRow && (
                                <span className="ml-2 rounded-full bg-[var(--gold)] px-2 py-0.5 align-middle text-xs font-bold text-white">
                                  TODAY
                                </span>
                              )}
                            </span>
                            <span className="text-sm text-[var(--dim)]">
                              {d.hijriLabel}
                            </span>
                          </p>
                          <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5">
                            {PRAYERS.map((p) => (
                              <div key={p.key} className="flex items-baseline justify-between gap-1">
                                <dt className="text-xs text-[var(--dim)]">{p.en}</dt>
                                <dd className="text-sm font-medium tabular-nums">
                                  {fmt12(d[p.key as PrayerKey])}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            <footer className="mt-8 border-t border-[var(--border)] pt-4 text-sm text-[var(--dim)]">
              <p>
                Source: Aladhan Prayer Times API · Calculation: University of
                Islamic Sciences, Karachi · Asr: Hanafi · Times in Pakistan
                Time (PKT).
              </p>
              {today.data && (
                <p className="mt-1">
                  Last updated{" "}
                  {new Intl.DateTimeFormat("en-GB", {
                    timeZone: "Asia/Karachi",
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                    day: "numeric",
                    month: "short",
                  }).format(new Date(today.data.fetchedAt))}{" "}
                  PKT. Times refresh automatically every day.
                </p>
              )}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
