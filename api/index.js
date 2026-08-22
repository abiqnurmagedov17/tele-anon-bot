const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const token = process.env.BOT_TOKEN;
const secretToken = process.env.TELEGRAM_SECRET_TOKEN; // Secret token untuk keamanan Webhook

const bot = new TelegramBot(token);

// Key Konstanta Redis
const WAITING_SET = 'waiting_users';
const PAIRS_HASH = 'pairs';

module.exports = async (req, res) => {
  // 1. Keamanan Webhook: Hanya terima POST dan verifikasi Secret Token
  if (req.method !== 'POST') {
    return res.status(200).send('Vercel Anonymous Bot Engine Active!');
  }

  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken && incomingSecret !== secretToken) {
    console.warn('Unauthorized request: Secret token mismatch');
    return res.status(403).send('Forbidden');
  }

  const update = req.body;
  if (!update || !update.update_id) {
    return res.status(200).send('OK');
  }

  // 2. Deduplikasi Update ID (Mencegah Replay Event dari Telegram)
  const updateKey = `processed_update:${update.update_id}`;
  const isProcessed = await redis.set(updateKey, '1', { nx: true, ex: 86400 }); // TTL 24 jam
  
  if (!isProcessed) {
    // Jika key sudah ada, update ini sudah pernah diproses
    return res.status(200).send('OK');
  }

  // Hanya proses private chat message biasa (abaikan channel, edited_message, group, dll)
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') {
    return res.status(200).send('OK');
  }

  const chatId = msg.chat.id.toString();
  const text = msg.text || '';

  try {
    // Ambil partner jika sedang dalam obrolan
    const partnerId = await redis.hget(PAIRS_HASH, chatId);

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
      await handleRandomMatch(chatId, partnerId);
    } 

    // --- COMMAND: /stop ---
    else if (text === '/stop') {
      await handleStopChat(chatId, partnerId);
    } 

    // --- COMMAND: /next ---
    else if (text === '/next') {
      if (partnerId) {
        await cleanupPair(chatId, partnerId);
        await bot.sendMessage(chatId, "🔄 Obrolan dihentikan.");
        await notifyUserQuietly(partnerId, "🛑 Teman bicara kamu telah meninggalkan obrolan. Ketik /random untuk cari pasangan baru.");
      } else {
        await redis.srem(WAITING_SET, chatId);
      }
      // Langsung cari partner baru
      await handleRandomMatch(chatId, null);
    } 

    // --- RELAY PESAN (Teks, Media, Sticker, Voice, Document, dll) ---
    else {
      // Jika merupakan command yang tidak dikenali, abaikan
      if (text.startsWith('/')) {
        return res.status(200).send('OK');
      }

      if (partnerId) {
        try {
          await bot.copyMessage(partnerId, chatId, msg.message_id);
        } catch (err) {
          // Jika gagal kirim (misal partner blokir bot), bersihkan pair
          console.error(`Gagal relay dari ${chatId} ke ${partnerId}:`, err.message);
          await cleanupPair(chatId, partnerId);
          await bot.sendMessage(chatId, "⚠️ Pasangan kamu tidak dapat menerima pesan (mungkin telah memblokir bot). Obrolan dihentikan.\nKetik /random untuk mencari pasangan baru.");
        }
      } else {
        const isWaiting = await redis.sismember(WAITING_SET, chatId);
        if (isWaiting) {
          await bot.sendMessage(chatId, "⏳ Kamu masih dalam antrean. Mohon tunggu pasangan acak...");
        } else {
          await bot.sendMessage(chatId, "⚠️ Kamu belum terhubung. Ketik /random untuk mencari teman chat.");
        }
      }
    }
  } catch (error) {
    console.error("Error processing update:", error);
  }

  return res.status(200).send('OK');
};

// ==========================================
// HELPER FUNCTIONS & LOGIK ATOMIC REDIS
// ==========================================

// Logika Matchmaking Atomic
async function handleRandomMatch(chatId, existingPartnerId) {
  if (existingPartnerId) {
    await bot.sendMessage(chatId, "⚠️ Kamu sedang dalam obrolan! Ketik /next untuk ganti atau /stop untuk keluar.");
    return;
  }

  // Cek apakah user sudah ada di waiting queue
  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) {
    await bot.sendMessage(chatId, "⏳ Kamu sudah ada di antrean. Mohon tunggu...");
    return;
  }

  // Coba ambil 1 kandidat pasangan secara ATOMIC dari Set
  let matchedUser = await redis.spop(WAITING_SET);

  // Jika kandidat yang ter-SPOP adalah diri sendiri (edge case), ganti penanganannya
  if (matchedUser === chatId) {
    matchedUser = await redis.spop(WAITING_SET);
  }

  if (matchedUser) {
    // Berhasil menemukan pasangan!
    // Simpan pairing dua arah ke Redis Hash
    await redis.hset(PAIRS_HASH, {
      [chatId]: matchedUser,
      [matchedUser]: chatId
    });

    // Kirim notifikasi ke kedua belah pihak
    const msgText = "🎉 Pasangan ditemukan! Selamat mengobrol.\nKetik /next untuk ganti, /stop untuk berhenti.";
    await bot.sendMessage(chatId, msgText);
    
    const sent = await notifyUserQuietly(matchedUser, msgText);
    if (!sent) {
      // Jika matchedUser gagal dikirimi pesan (misal memblokir bot), rollback pairing
      await cleanupPair(chatId, matchedUser);
      await bot.sendMessage(chatId, "⚠️ Pasangan yang ditemukan tidak aktif/memblokir bot. Mencari pasangan lain...");
      // Re-run pencarian untuk chatId
      await handleRandomMatch(chatId, null);
    }
  } else {
    // Antrean kosong: Tambahkan chatId ke antrean secara ATOMIC
    await redis.sadd(WAITING_SET, chatId);
    await bot.sendMessage(chatId, "🔍 Mencari teman obrolan...");
  }
}

// Logika Stop Chat
async function handleStopChat(chatId, partnerId) {
  // Cek jika sedang di antrean
  const removedFromQueue = await redis.srem(WAITING_SET, chatId);
  if (removedFromQueue) {
    await bot.sendMessage(chatId, "🛑 Kamu telah keluar dari antrean.");
    return;
  }

  if (!partnerId) {
    await bot.sendMessage(chatId, "⚠️ Kamu sedang tidak terhubung dengan siapa pun.");
    return;
  }

  // Hapus pairing dari Redis
  await cleanupPair(chatId, partnerId);

  await bot.sendMessage(chatId, "🛑 Obrolan dihentikan. Ketik /random untuk cari pasangan baru.");
  await notifyUserQuietly(partnerId, "🛑 Teman bicara kamu telah menghentikan obrolan. Ketik /random untuk cari pasangan baru.");
}

// Helper untuk menghapus pair dua arah secara aman
async function cleanupPair(userA, userB) {
  await redis.hdel(PAIRS_HASH, userA, userB);
}

// Helper pengiriman pesan yang aman jika target user menolak/block
async function notifyUserQuietly(userId, text) {
  try {
    await bot.sendMessage(userId, text);
    return true;
  } catch (err) {
    console.error(`Gagal mengirim notifikasi ke user ${userId}:`, err.message);
    return false;
  }
}
