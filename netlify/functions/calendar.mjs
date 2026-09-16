const VGIK_URL = "https://rasp.vgik.info/sections/raspisanie/index.php";

const DEFAULTS = {
  workshop: "1,551",
  semester: "2026.1",
  facultyId: "22",
  workWeek: "6",
  pastWeeks: 2,
  futureWeeks: 8,
};

const CALENDAR_NAME = "ВГИК — мастерская А. С. Алибекова";
const GROUP_NAME = "1 Мастерская Алибекова А. С. (2026)";
const encoder = new TextEncoder();

function text(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/Tokens?\s*:\s*\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSchedule(html) {
  const lessons = [];
  const blockPattern = /<center[^>]*class=["'][^"']*hdr_md[^"']*["'][^>]*>([\s\S]*?)<\/center>[\s\S]*?<table[^>]*class=["'][^"']*dtatab[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;

  for (const block of html.matchAll(blockPattern)) {
    const day = text(block[1]);
    const rows = [...block[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (!rows.length) continue;

    const cellValues = (row) =>
      [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((item) => text(item[1]));
    const headers = cellValues(rows[0][1]);
    const column = Object.fromEntries(headers.map((name, index) => [name, index]));
    if (!["Время", "Дисциплина", "Преподаватель", "Аудитория"].every((name) => name in column)) continue;

    for (const row of rows.slice(1)) {
      const cells = cellValues(row[1]);
      const time = cells[column["Время"]] || "";
      const title = cells[column["Дисциплина"]] || "";
      if (!/^\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}$/.test(time) || !title) continue;
      lessons.push({
        day,
        time: time.replace(/[–—]/g, "-"),
        title,
        auditory: cells[column["Аудитория"]] || "",
        teacher: cells[column["Преподаватель"]] || "",
        building: "Корпус" in column ? cells[column["Корпус"]] || "" : "",
      });
    }
  }
  return lessons;
}

function buildScheduleUrl({ workshop, week, semester, facultyId, workWeek }) {
  const source = new URL(VGIK_URL);
  Object.entries({
    sec: "schedule",
    semester,
    faculty_id: facultyId,
    gid: workshop,
    auditory_id: "0",
    schedule_week: week,
    work_week: workWeek,
  }).forEach(([key, value]) => source.searchParams.set(key, value));
  return source;
}

async function fetchScheduleWeek(settings) {
  const source = buildScheduleUrl(settings);
  const response = await fetch(source, { headers: { "user-agent": "VGIK Calendar/1.0" } });
  if (!response.ok) throw new Error(`VGIK returned ${response.status}`);
  const bytes = await response.arrayBuffer();
  const html = new TextDecoder("windows-1251").decode(bytes);
  return parseSchedule(html);
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function mondayOf(date) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function calendarWeeks(now, pastWeeks = DEFAULTS.pastWeeks, futureWeeks = DEFAULTS.futureWeeks) {
  const currentMonday = mondayOf(now);
  const firstMonday = addDays(currentMonday, -7 * pastWeeks);
  return Array.from({ length: pastWeeks + futureWeeks + 1 }, (_, index) => isoDate(addDays(firstMonday, index * 7)));
}

function parseLessonDate(day) {
  const match = String(day).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  return { year: match[3], month: match[2], day: match[1] };
}

function parseLessonTime(time) {
  const match = String(time).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return {
    startHour: match[1].padStart(2, "0"),
    startMinute: match[2],
    endHour: match[3].padStart(2, "0"),
    endMinute: match[4],
  };
}

function icsDateTime(date, hour, minute) {
  return `${date.year}${date.month}${date.day}T${hour}${minute}00`;
}

export function escapeIcs(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line) {
  const result = [];
  let current = "";
  for (const character of line) {
    if (encoder.encode(current + character).length > 75) {
      result.push(current);
      current = ` ${character}`;
    } else {
      current += character;
    }
  }
  result.push(current);
  return result.join("\r\n");
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function eventLines(lesson, settings, generatedAt) {
  const date = parseLessonDate(lesson.day);
  const time = parseLessonTime(lesson.time);
  if (!date || !time) return [];

  const location = [lesson.building, lesson.auditory && `ауд. ${lesson.auditory}`].filter(Boolean).join(", ");
  const identity = [settings.workshop, lesson.day, lesson.time, lesson.title, lesson.teacher, location].join("|");
  const week = mondayOf(new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day))));
  const source = buildScheduleUrl({ ...settings, week: isoDate(week) }).toString();
  const description = [
    lesson.teacher && `Преподаватель: ${lesson.teacher}`,
    `Группа: ${GROUP_NAME}`,
    "Расписание обновляется автоматически с сайта ВГИКа.",
  ].filter(Boolean).join("\n");

  return [
    "BEGIN:VEVENT",
    `UID:vgik-${hash(identity)}@rasp.vgik.info`,
    `DTSTAMP:${stamp(generatedAt)}`,
    `DTSTART;TZID=Europe/Moscow:${icsDateTime(date, time.startHour, time.startMinute)}`,
    `DTEND;TZID=Europe/Moscow:${icsDateTime(date, time.endHour, time.endMinute)}`,
    `SUMMARY:${escapeIcs(lesson.title)}`,
    location && `LOCATION:${escapeIcs(location)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `URL:${escapeIcs(source)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ].filter(Boolean);
}

export function buildCalendar(lessons, settings, generatedAt = new Date()) {
  const unique = new Map();
  for (const lesson of lessons) {
    const key = [lesson.day, lesson.time, lesson.title, lesson.teacher, lesson.building, lesson.auditory].join("|");
    unique.set(key, lesson);
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//VGIK Schedule//Calendar RU//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(CALENDAR_NAME)}`,
    "X-WR-TIMEZONE:Europe/Moscow",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Moscow",
    "X-LIC-LOCATION:Europe/Moscow",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0300",
    "TZOFFSETTO:+0300",
    "TZNAME:MSK",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  const sorted = [...unique.values()].sort((left, right) => `${left.day}|${left.time}`.localeCompare(`${right.day}|${right.time}`));
  for (const lesson of sorted) lines.push(...eventLines(lesson, settings, generatedAt));
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function integerParam(value, fallback, minimum, maximum) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

async function fetchWeeks(weeks, settings) {
  const lessons = [];
  const batchSize = 4;
  for (let index = 0; index < weeks.length; index += batchSize) {
    const batch = weeks.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((week) => fetchScheduleWeek({ ...settings, week })));
    for (const result of results) lessons.push(...result);
  }
  return lessons;
}

function errorResponse(message, status = 400) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async (request) => {
  const input = new URL(request.url);
  const settings = {
    workshop: input.searchParams.get("workshop") || DEFAULTS.workshop,
    semester: input.searchParams.get("semester") || DEFAULTS.semester,
    facultyId: input.searchParams.get("faculty_id") || DEFAULTS.facultyId,
    workWeek: input.searchParams.get("work_week") || DEFAULTS.workWeek,
  };
  const pastWeeks = integerParam(input.searchParams.get("past_weeks"), DEFAULTS.pastWeeks, 0, 8);
  const futureWeeks = integerParam(input.searchParams.get("future_weeks"), DEFAULTS.futureWeeks, 0, 18);

  if (!/^\d+(,\d+)*$/.test(settings.workshop)) return errorResponse("Некорректная мастерская");
  if (!/^\d{4}\.\d+$/.test(settings.semester)) return errorResponse("Некорректный семестр");
  if (pastWeeks === null || futureWeeks === null) return errorResponse("Некорректный диапазон недель");

  try {
    const generatedAt = new Date();
    const weeks = calendarWeeks(generatedAt, pastWeeks, futureWeeks);
    const lessons = await fetchWeeks(weeks, settings);
    const calendar = buildCalendar(lessons, settings, generatedAt);
    return new Response(calendar, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="vgik-schedule.ics"',
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=900, stale-while-revalidate=3600",
        "x-calendar-events": String(lessons.length),
      },
    });
  } catch (error) {
    return errorResponse(`Не удалось обновить календарь ВГИКа: ${error.message}`, 502);
  }
};
