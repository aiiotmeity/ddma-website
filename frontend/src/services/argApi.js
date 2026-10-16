
const API_URL =
  `${import.meta.env.VITE_API_URL || "http://127.0.0.1:8000/api"}/arg/latest/`;

export async function getLatestArgData() {
  const response = await fetch(API_URL);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error("Unable to retrieve ARG station data");
  }

  // Return the latest station readings
  return result.data?.latest ?? {};
}
