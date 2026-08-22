const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

// Inisialisasi Redis & Telegram Bot
const redis = Redis.fromEnv();
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token);

// Key untuk Redis
const QUEUE_KEY = 'anonymous_queue';
const PAIRS_KEY = 'anonymous_pairs';

module.exports = async (req, res) => {
  // Hanya terima request POST dari Telegram Webhook
  if (req.method !== 'POST') {
    return res.status(200).send('Bot Serverless Vercel Active!');
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).send('OK');
  }

  const msg = update.message;
  const chatId = msg.chat.id.toString();
  const text = msg.text || '';

  try {
    // Check apakah user sedang punya pasangan
    const partnerId = await redis.hget(PAIRS_KEY, chatId);

    // --- COMMAND: /start ---
    if (text === '/start') {
      await bot.sendMessage(
        chatId,
        "🤖 *Selamat datang di Anonymous Chat Bot!*\n\n" +
        "Gunakan perintah berikut:\n" +
        "🎲 `/random` - Cari teman obrolan acak\n" +
        "🔄 `/next` - Ganti ke teman obrolan baru\n" +
        "🛑 `/stop` - Hentikan obrolan saat ini",
        { parse_mode: "Markdown" }
      );
    } 

    // --- COMMAND: /random ---
    else if (text === '/random') {
      if (partnerId) {
        await bot.sendMessage(chatId, "⚠️ Kamu sedang dalam obrolan! Ketik /next untuk ganti atau /stop untuk keluar.");
        return res.status(200).send('OK');
      }

      // Ambil antrean saat ini
      const queue = (await redis.get(QUEUE_KEY)) || [];
      
      if (queue.includes(chatId)) {
        await bot.sendMessage(chatId, "⏳ Kamu sudah ada di antrean. Mohon tunggu...");
        return res.status(200).send('OK');
      }

      if (queue.length > 0) {
        // Ambil pasangan dari antrean
        const partner = queue.shift();
        await redis.set(QUEUE_KEY, queue);

        // Simpan pasangan di Redis (dua arah)
        await redis.hset(PAIRS_KEY, {
          [chatId]: partner,
          [partner]: chatId
        });

        await bot.sendMessage(chatId, "🎉 Pasangan ditemukan! Selamat mengobrol.\nKetik /next untuk ganti, /stop untuk berhenti.");
        await bot.sendMessage(partner, "🎉 Pasangan ditemukan! Selamat mengobrol.\nKetik /next untuk ganti, /stop untuk berhenti.");
      } else {
        // Masukkan ke antrean
        queue.push(chatId);
        await redis.set(QUEUE_KEY, queue);
        await bot.sendMessage(chatId, "🔍 Mencari teman obrolan...");
      }
    } 

    // --- COMMAND: /stop ---
    else if (text === '/stop') {
      let queue = (await redis.get(QUEUE_KEY)) || [];

      // Jika user sedang di antrean
      if (queue.includes(chatId)) {
        queue = queue.filter(id => id !== chatId);
        await redis.set(QUEUE_KEY, queue);
        await bot.sendMessage(chatId, "🛑 Kamu telah keluar dari antrean.");
        return res.status(200).send('OK');
      }

      if (!partnerId) {
        await bot.sendMessage(chatId, "⚠️ Kamu sedang tidak terhubung dengan siapa pun.");
        return res.status(200).send('OK');
      }

      // Hapus pasangan dari Redis
      await redis.hdel(PAIRS_KEY, chatId, partnerId);

      await bot.sendMessage(chatId, "🛑 Obrolan dihentikan. Ketik /random untuk cari pasangan baru.");
      await bot.sendMessage(partnerId, "🛑 Teman bicara kamu telah menghentikan obrolan. Ketik /random untuk cari pasangan baru.");
    } 

    // --- COMMAND: /next ---
    else if (text === '/next') {
      if (partnerId) {
        await redis.hdel(PAIRS_KEY, chatId, partnerId);
        await bot.sendMessage(chatId, "🔄 Obrolan dihentikan.");
        await bot.sendMessage(partnerId, "🛑 Teman bicara kamu meninggalkan obrolan. Ketik /random untuk cari pasangan baru.");
      }

      let queue = (await redis.get(QUEUE_KEY)) || [];
      queue = queue.filter(id => id !== chatId);

      if (queue.length > 0) {
        const partner = queue.shift();
        await redis.set(QUEUE_KEY, queue);

        await redis.hset(PAIRS_KEY, {
          [chatId]: partner,
          [partner]: chatId
        });

        await bot.sendMessage(chatId, "🎉 Pasangan baru ditemukan!");
        await bot.sendMessage(partner, "🎉 Pasangan baru ditemukan!");
      } else {
        queue.push(chatId);
        await redis.set(QUEUE_KEY, queue);
        await bot.sendMessage(chatId, "🔍 Mencari teman obrolan baru...");
      }
    } 

    // --- RELAY PESAN (Teks, Foto, Stiker, Voice, Video, dll) ---
    else {
      if (partnerId) {
        await bot.copyMessage(partnerId, chatId, msg.message_id);
      } else {
        const queue = (await redis.get(QUEUE_KEY)) || [];
        if (!queue.includes(chatId)) {
          await bot.sendMessage(chatId, "⚠️ Kamu belum terhubung. Ketik /random untuk mencari teman chat.");
        }
      }
    }
  } catch (error) {
    console.error("Error processing update:", error);
  }

  return res.status(200).send('OK');
};
