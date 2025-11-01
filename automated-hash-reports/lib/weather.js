// lib/weather.js
// Fetch Sylvania, GA weather (no API key) and return a compact payload
// used by scripts/refresh.js

const TZ = 'America/New_York';
const LAT = 32.7504;
const LON = -81.6365;

// Open-Meteo weather_code → human label
const WMO = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Light rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm w/ slight hail',
  99: 'Thunderstorm w/ heavy hail'
};

function codeToLabel(code) {
  if (code == null) return '—';
  return WMO[Number(code)] || '—';
}

function formatHourLabel(dt) {
  let h = dt.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h} ${ap}`;
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// Parse an Open-Meteo local timestamp like "2025-08-28T06:00"
function parseLocalHour(ts) {
  // ts format: YYYY-MM-DDTHH:mm (no offset)
  const [datePart, timePart] = String(ts).split('T');
  if (!datePart || !timePart) return new Date(NaN);
  const [y, m, d] = datePart.split('-').map(n => parseInt(n, 10));
  const [H, M] = timePart.split(':').map(n => parseInt(n, 10));
  // Construct as system-local, but we only use it for display labels.
  return new Date(y, (m || 1) - 1, d || 1, H || 0, M || 0, 0, 0);
}

// Current hour as a string "YYYY-MM-DDTHH:00" in the target TZ.
function nowIsoHourInTZ(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date()).map(p => [p.type, p.value]));
  // Compose "YYYY-MM-DDTHH:00"
  const y = parts.year;
  const m = parts.month;
  const d = parts.day;
  const H = parts.hour;
  return `${y}-${m}-${d}T${H}:00`;
}

export async function fetchSylvaniaWeather() {
  const generatedAt = new Date().toISOString();

  // 12 hours of observed + 12 hours forecast; return Fahrenheit, local Time Zone
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,relative_humidity_2m,weathercode` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,is_day` +
    `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}` +
    `&past_hours=12&forecast_hours=12`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();

  // Current
  const curTempF = j?.current?.temperature_2m ?? null;
  const curHum    = j?.current?.relative_humidity_2m ?? null;
  const curCode   = j?.current?.weather_code ?? null;
  const curLabel  = codeToLabel(curCode);

  // Hourly points in local time
  const times = j?.hourly?.time ?? [];
  const temps = j?.hourly?.temperature_2m ?? [];
  const nowStrLocal = nowIsoHourInTZ(TZ);

  const points = times.map((t, i) => {
    const dt = parseLocalHour(t);
    return {
      time_utc: t,
      label_local: formatHourLabel(dt),
      temp_f: (temps[i] ?? null),
      forecast: t > nowStrLocal
    };
  });

  // Today’s high and its hour window
  const nowLocalForDay = parseLocalHour(nowStrLocal);
  let highIdx = -1, highVal = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const dt = parseLocalHour(times[i]);
    if (!sameLocalDay(dt, nowLocalForDay)) continue;
    const v = temps[i];
    if (v != null && v > highVal) { highVal = v; highIdx = i; }
  }
  let highWindow = '—';
  if (highIdx >= 0) {
    const start = parseLocalHour(times[highIdx]);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);
    highWindow = `${formatHourLabel(start)} - ${formatHourLabel(end)}`;
  }

  // “Today” label: most common weather_code over the rest of today
  let todayLabel = curLabel;
  const codes = j?.hourly?.weathercode ?? [];
  const counts = {};
  for (let i = 0; i < times.length; i++) {
    const dt = parseLocalHour(times[i]);
    if (sameLocalDay(dt, nowLocalForDay)) {
      const c = codes[i];
      if (c != null) counts[c] = (counts[c] || 0) + 1;
    }
  }
  const topCode = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0];
  if (topCode != null) todayLabel = codeToLabel(topCode);

  return {
    sylvania: {
      generatedAt,
      current: {
        temperature_f: curTempF,
        humidity_pct: curHum,
        label: curLabel
      },
      today: {
        high_f: (highVal === -Infinity ? null : highVal),
        high_time_window_local: highWindow,
        label: todayLabel
      },
      hourly: { points }
    }
  };
}
