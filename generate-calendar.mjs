import { mkdir, readFile, writeFile } from "node:fs/promises";

const VGIK_URL = "https://rasp.vgik.info/sections/raspisanie/index.php";
const OUTPUT = new URL("../public/calendar.ics", import.meta.url);
const SETTINGS = {
  workshop: "1,551",
  facultyId: "22",
  workWeek: "6",
  pastWeeks: 2,
  futureWeeks: 8,
};
const CALENDAR_NAME = "ВГИК — мастерская А. С. Алибекова";
const GROUP_NAME = "1 Мастерская Алибекова А. С. (2026)";
const encoder = new TextEncoder();

function moscowNow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

function semesterFor(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const academicYear = month >= 8 ? year : year - 1;
  return `${academicYear}.${month >= 8 || month === 1 ? 1 : 2}`;
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function mondayOf(date) {
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

function calendarWeeks(now) {
  const currentMonday = mondayOf(now);
  const firstMonday = addDays(currentMonday, -7 * SETTINGS.pastWeeks);
  return Array.from(
    { length: SETTINGS.pastWeeks + SETTINGS.futureWeeks + 1 },
    (_, index) => isoDate(addDays(firstMonday, index * 7)),
  );
}

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
  const blocks = /<center[^>]*class=["'][^"']*hdr_md[^"']*["'][^>]*>([\s\S]*?)<\/center>[\s\S]*?<table[^>]*class=["'][^"']*dtatab[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;

  for (const block of html.matchAll(blocks)) {
    const day = text(block[1]);
    const rows = [...block[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (!rows.length) continue;
    const cells = (row) => [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((item) => text(item[1]));
    const headers = cells(rows[0][1]);
    const column = Object.fromEntries(headers.map((name, index) => [name, index]));
    if (!["Время", "Дисциплина", "Преподаватель", "Аудитория"].every((name) => name in column)) continue;

    for (const row of rows.slice(1)) {
      const values = cells(row[1]);
      const time = values[column["Время"]] || "";
      const title = values[column["Дисциплина"]] || "";
      if (!/^\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}$/.test(time) || !title) continue;
      lessons.push({
        day,
        time: time.replace(/[–—]/g, "-"),
        title,
        teacher: values[column["Преподаватель"]] || "",
        building: "Корпус" in column ? values[column["Корпус"]] || "" : "",
        auditory: values[column["Аудитория"]] || "",
      });
    }
  }
  return lessons;
}

function scheduleUrl(week, semester) {
  const url = new URL(VGIK_URL);
  Object.entries({
    sec: "schedule",
    semester,
    faculty_id: SETTINGS.facultyId,
    gid: SETTINGS.workshop,
    auditory_id: "0",
    schedule_week: week,
    work_week: SETTINGS.workWeek,
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWeek(week, semester) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(scheduleUrl(week, semester), {
        headers: { "user-agent": "VGIK Calendar Updater/2.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = new TextDecoder("windows-1251").decode(await response.arrayBuffer());
      return parseSchedule(html);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 3_000);
    }
  }
  throw new Error(`Неделя ${week}: ${lastError.message}`);
}

async function fetchAllWeeks(weeks, semester) {
  const lessons = [];
  for (let index = 0; index < weeks.length; index += 3) {
    const batch = weeks.slice(index, index + 3);
    const results = await Promise.all(batch.map((week) => fetchWeek(week, semester)));
    results.forEach((items) => lessons.push(...items));
  }
  return lessons;
}

function escapeIcs(value = "") {
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

function eventLines(lesson, semester) {
  const date = lesson.day.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const time = lesson.time.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!date || !time) return [];
  const [, day, month, year] = date;
  const start = `${year}${month}${day}T${time[1].padStart(2, "0")}${time[2]}00`;
  const end = `${year}${month}${day}T${time[3].padStart(2, "0")}${time[4]}00`;
  const location = [lesson.building, lesson.auditory && `ауд. ${lesson.auditory}`].filter(Boolean).join(", ");
  const identity = [SETTINGS.workshop, lesson.day, lesson.time, lesson.title, lesson.teacher, location].join("|");
  const lessonDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const source = scheduleUrl(isoDate(mondayOf(lessonDate)), semester).toString();
  const description = [
    lesson.teacher && `Преподаватель: ${lesson.teacher}`,
    `Группа: ${GROUP_NAME}`,
    "Расписание автоматически обновляется с сайта ВГИКа.",
  ].filter(Boolean).join("\n");

  return [
    "BEGIN:VEVENT",
    `UID:vgik-${hash(identity)}@rasp.vgik.info`,
    `DTSTAMP:${year}${month}${day}T000000Z`,
    `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`,
    `SUMMARY:${escapeIcs(lesson.title)}`,
    location && `LOCATION:${escapeIcs(location)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `URL:${escapeIcs(source)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ].filter(Boolean);
}

function buildCalendar(lessons, semester) {
  const unique = new Map();
  for (const lesson of lessons) {
    const key = [lesson.day, lesson.time, lesson.title, lesson.teacher, lesson.building, lesson.auditory].join("|");
    unique.set(key, lesson);
  }
  const sorted = [...unique.values()].sort((a, b) => `${a.day}|${a.time}`.localeCompare(`${b.day}|${b.time}`));
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//VGIK Schedule//Static Calendar RU//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeIcs(CALENDAR_NAME)}`,
    "X-WR-TIMEZONE:Europe/Moscow", "REFRESH-INTERVAL;VALUE=DURATION:PT2H", "X-PUBLISHED-TTL:PT2H",
    "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "X-LIC-LOCATION:Europe/Moscow", "BEGIN:STANDARD",
    "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "TZNAME:MSK", "DTSTART:19700101T000000",
    "END:STANDARD", "END:VTIMEZONE",
  ];
  sorted.forEach((lesson) => lines.push(...eventLines(lesson, semester)));
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

const now = moscowNow();
const semester = process.env.VGIK_SEMESTER || semesterFor(now);
const weeks = calendarWeeks(now);
console.log(`Обновляю семестр ${semester}: ${weeks[0]} — ${weeks.at(-1)}`);
const lessons = await fetchAllWeeks(weeks, semester);
if (!lessons.length) throw new Error("В расписании не найдено ни одного занятия; старый календарь сохранён");
const calendar = buildCalendar(lessons, semester);
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
let previous = "";
try { previous = await readFile(OUTPUT, "utf8"); } catch {}
if (previous !== calendar) {
  await writeFile(OUTPUT, calendar, "utf8");
  console.log(`Готово: ${lessons.length} занятий, файл обновлён`);
} else {
  console.log(`Готово: ${lessons.length} занятий, изменений нет`);
}
