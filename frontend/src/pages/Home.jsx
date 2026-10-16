
import { useEffect, useState } from "react";
import { getLatestArgData } from "../services/argApi";

export default function Home() {
  const [station, setStation] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getLatestArgData()
      .then(setStation)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p>Error: {error}</p>;
  if (!station) return <p>Loading station data...</p>;

  return (
    <section>
      <h2>ARG Station: ARGS1</h2>
      <p>Rainfall: {station["RFD(mm)"]} mm</p>
      <p>Temperature: {station["T(C)"]} °C</p>
      <p>Humidity: {station["RH(%)"]} %</p>
      <p>Timestamp: {station.Timestamp}</p>
    </section>
  );
}
