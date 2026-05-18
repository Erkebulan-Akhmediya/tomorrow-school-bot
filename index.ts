import { Database } from "bun:sqlite";
import { Telegraf } from "telegraf";
import * as Minio from "minio";

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const MINIO_HOST = process.env.MINIO_HOST || "127.0.0.1";
const MINIO_PORT = parseInt(process.env.MINIO_PORT || "9000");
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "bot-photos";
const SQLITE_FILE = process.env.SQLITE_FILE || "bot.db";

// Initialize SQLite DB
const db = new Database(SQLITE_FILE, { create: true });
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    photo_object_name TEXT
  )
`);

// Initialize Minio
const minioClient = new Minio.Client({
  endPoint: MINIO_HOST,
  port: MINIO_PORT,
  useSSL: false,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// Ensure bucket exists
async function ensureBucket() {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
      console.log(`Bucket ${MINIO_BUCKET} created.`);
    }
  } catch (err) {
    console.error("Error checking/creating MinIO bucket. Make sure MinIO is running.", err);
  }
}
ensureBucket();

// Initialize Telegraf Bot
const bot = new Telegraf(BOT_TOKEN);

bot.command("photo", async (ctx) => {
  const username = ctx.from?.username;
  if (!username) {
    return ctx.reply("Please set a Telegram username to use this bot.");
  }

  const stmt = db.query(`SELECT photo_object_name FROM users WHERE username = ?`);
  const row = stmt.get(username) as { photo_object_name: string } | null;

  if (!row) {
    return ctx.reply("No photo associated with your username.");
  }

  const objectName = row.photo_object_name;

  try {
    const stream = await minioClient.getObject(MINIO_BUCKET, objectName);

    // Send photo
    await ctx.replyWithPhoto({ source: stream });

    // Delete photo and DB record after successful send
    try {
      await minioClient.removeObject(MINIO_BUCKET, objectName);
    } catch (removeErr) {
      console.error("Failed to remove object from minio:", removeErr);
    }

    db.run(`DELETE FROM users WHERE username = ?`, [username]);

  } catch (err) {
    console.error("Error sending photo:", err);
    ctx.reply("Failed to send photo. Retaining the record and photo.");
  }
});

bot.launch().then(() => console.log("Telegram Bot is running...")).catch(err => {
  console.error("Failed to start bot, please check your BOT_TOKEN:", err.message);
});

// Web Server for API
const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/upload") {
      try {
        const formData = await req.formData();
        const username = formData.get("username");
        const photo = formData.get("photo");

        if (!username || typeof username !== "string") {
          return new Response("Missing or invalid username", { status: 400 });
        }

        if (!photo || typeof photo === "string") {
          return new Response("Missing or invalid photo", { status: 400 });
        }

        const buffer = Buffer.from(await photo.arrayBuffer());

        // Ensure username is clean (remove @ if present)
        const cleanUsername = username.replace(/^@/, '');

        // Handle override: delete old photo from minio if it exists
        const oldRow = db.query(`SELECT photo_object_name FROM users WHERE username = ?`).get(cleanUsername) as { photo_object_name: string } | null;
        if (oldRow) {
          try {
            await minioClient.removeObject(MINIO_BUCKET, oldRow.photo_object_name);
          } catch (e) {
            console.error("Failed to delete old photo from minio:", e);
          }
        }

        const objectName = `${cleanUsername}-${Date.now()}-${photo.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

        // Save to Minio
        await minioClient.putObject(MINIO_BUCKET, objectName, buffer, buffer.length);

        // Save to SQLite (upsert)
        db.run(`
          INSERT INTO users (username, photo_object_name)
          VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET
            photo_object_name = excluded.photo_object_name
        `, [cleanUsername, objectName]);

        return new Response(JSON.stringify({ success: true, message: "Photo uploaded successfully" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Upload error:", err);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server listening on http://localhost:${server.port}`);

// Graceful stop
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.stop();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.stop();
});