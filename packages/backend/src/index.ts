import { createApp } from "./app";

const port = Number(process.env.PORT) || 3001;
const dbPath = process.env.DATABASE_PATH || "tebakani.sqlite";

const { app } = createApp(dbPath);

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
