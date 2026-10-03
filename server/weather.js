// Jobsite weather from Open-Meteo (free, no API key) with construction work-impact flags.
const CACHE_MS = 30 * 60_000;
const cache = new Map();

const CODES = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
export const describe = (code) => CODES[code] || ['Unknown', '🌡️'];

// Thresholds a superintendent would care about (°F, mph, %).
export function impacts(day) {
  const out = [];
  if (day.precip_prob >= 50 || day.precip_in >= 0.1) out.push({ level: 'warn', text: `Rain ${day.precip_prob}% — protect pours, roofing and open excavations` });
  if (day.wind_gust_mph >= 30) out.push({ level: 'stop', text: `Gusts ${day.wind_gust_mph} mph — no crane picks or aerial lifts` });
  else if (day.wind_max_mph >= 20) out.push({ level: 'warn', text: `Wind ${day.wind_max_mph} mph — check crane and lift limits` });
  if (day.temp_max_f >= 95) out.push({ level: 'warn', text: `Heat ${day.temp_max_f}°F — heat-illness plan, water, shade, early start` });
  if (day.temp_min_f <= 32) out.push({ level: 'warn', text: `Freeze ${day.temp_min_f}°F — cold-weather concreting, protect water lines` });
  if ([95, 96, 99].includes(day.code)) out.push({ level: 'stop', text: 'Lightning risk — 30/30 rule for exposed work' });
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`weather service ${res.status}`);
  return res.json();
}

export async function geocode(place) {
  const q = String(place || '').split(',')[0].trim();
  if (!q) return null;
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(q)}`);
  const hit = data.results?.[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, label: [hit.name, hit.admin1].filter(Boolean).join(', ') } : null;
}

export async function forecast({ lat, lon }) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast?'
    + `latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=4&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset';
  const w = await getJson(url);
  const c = w.current;
  const days = w.daily.time.map((date, i) => {
    const day = {
      date,
      code: w.daily.weather_code[i],
      temp_max_f: Math.round(w.daily.temperature_2m_max[i]),
      temp_min_f: Math.round(w.daily.temperature_2m_min[i]),
      precip_prob: w.daily.precipitation_probability_max[i] ?? 0,
      precip_in: w.daily.precipitation_sum[i] ?? 0,
      wind_max_mph: Math.round(w.daily.wind_speed_10m_max[i]),
      wind_gust_mph: Math.round(w.daily.wind_gusts_10m_max[i]),
      sunrise: w.daily.sunrise[i]?.slice(11, 16),
      sunset: w.daily.sunset[i]?.slice(11, 16),
    };
    const [text, icon] = describe(day.code);
    return { ...day, text, icon, impacts: impacts(day) };
  });
  const [text, icon] = describe(c.weather_code);
  const data = {
    current: {
      temp_f: Math.round(c.temperature_2m), feels_f: Math.round(c.apparent_temperature), humidity: c.relative_humidity_2m,
      wind_mph: Math.round(c.wind_speed_10m), gust_mph: Math.round(c.wind_gusts_10m), code: c.weather_code, text, icon,
    },
    days,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Weather for every active project; geocodes and remembers coordinates on the project row.
export async function projectWeather(db) {
  const projects = db.prepare("SELECT * FROM projects WHERE status != 'closed' AND (location IS NOT NULL OR lat IS NOT NULL)").all();
  return Promise.all(projects.map(async (p) => {
    try {
      let { lat, lon } = p;
      if (lat == null || lon == null) {
        const g = await geocode(p.location);
        if (!g) return { project_id: p.id, project_name: p.name, location: p.location, error: 'Location not found — edit the project location' };
        ({ lat, lon } = g);
        db.prepare('UPDATE projects SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, p.id);
      }
      return { project_id: p.id, project_name: p.name, project_code: p.code, location: p.location, ...(await forecast({ lat, lon })) };
    } catch (err) {
      return { project_id: p.id, project_name: p.name, location: p.location, error: err.message };
    }
  }));
}
