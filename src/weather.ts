// Open-Meteo client. Public endpoint, no API key required.
// Fetches current weather, 24-hour hourly forecast, and sunrise/sunset in one call.

export type City = {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export type WeatherCurrent = {
  time: string;
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  precipitation: number;
  weatherCode: number;
  cloudCover: number;
  windSpeed: number;
  isDay: boolean;
};

export type WeatherHourly = {
  time: string;
  temperature: number;
  precipitation: number;
  cloudCover: number;
  windSpeed: number;
  isDay: boolean;
};

export type Weather = {
  location: City;
  current: WeatherCurrent;
  hourly: WeatherHourly[];
  sunrise: string;
  sunset: string;
  provider: string;
  fetchedAtUtc: string;
};

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

export async function fetchLocationWeather(city: City): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    timezone: city.timezone,
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,is_day",
    hourly: "temperature_2m,precipitation,cloud_cover,wind_speed_10m,is_day",
    forecast_hours: "24",
    daily: "sunrise,sunset",
    forecast_days: "1",
    wind_speed_unit: "kmh",
  });

  const url = `${OPEN_METEO_URL}?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo responded ${response.status}`);
  }

  const data: any = await response.json();

  const current: WeatherCurrent = {
    time: String(data?.current?.time ?? new Date().toISOString()),
    temperature: Number(data?.current?.temperature_2m ?? 0),
    apparentTemperature: Number(data?.current?.apparent_temperature ?? 0),
    humidity: Number(data?.current?.relative_humidity_2m ?? 0),
    precipitation: Number(data?.current?.precipitation ?? 0),
    weatherCode: Number(data?.current?.weather_code ?? 0),
    cloudCover: Number(data?.current?.cloud_cover ?? 0),
    windSpeed: Number(data?.current?.wind_speed_10m ?? 0),
    isDay: Boolean(data?.current?.is_day ?? 1),
  };

  const hourly: WeatherHourly[] = [];
  const hourlyTimes: string[] = Array.isArray(data?.hourly?.time) ? data.hourly.time : [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    hourly.push({
      time: hourlyTimes[i],
      temperature: Number(data.hourly.temperature_2m?.[i] ?? 0),
      precipitation: Number(data.hourly.precipitation?.[i] ?? 0),
      cloudCover: Number(data.hourly.cloud_cover?.[i] ?? 0),
      windSpeed: Number(data.hourly.wind_speed_10m?.[i] ?? 0),
      isDay: Boolean(data.hourly.is_day?.[i] ?? 0),
    });
  }

  const sunrise = String(data?.daily?.sunrise?.[0] ?? current.time);
  const sunset = String(data?.daily?.sunset?.[0] ?? current.time);

  return {
    location: city,
    current,
    hourly,
    sunrise,
    sunset,
    provider: "open-meteo.com",
    fetchedAtUtc: new Date().toISOString(),
  };
}