const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const token = process.env.BOT_TOKEN;
const secretToken = process.env.TELEGRAM_SECRET_TOKEN;

const bot = new TelegramBot(token);

const WAITING_SET = 'waiting_users';
const PAIRS_HASH = 'pairs';
const SEARCH_MSG_HASH = 'search_msgs';

// Helper Key Redis untuk menyimpan ID pesan per percakapan
const getChatHistoryKey = (userId) => `chat_history:${userId}`;

const MAIN_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🎲 Cari Teman Chat", callback_data: "cmd_random" }]
    ]
  },
  parse_mode: "HTML"
};

const CHATTING_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🔄 Ganti Pasangan", callback_data: "cmd_next" },
        { text: "🛑 Keluar Chat", callback_data: "cmd_stop" }
      ]
    ]
  },
  parse_mode: "HTML"
};

const QUEUE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "❌ Batal Antre", callback_data: "cmd_cancel_queue" }]
    ]
  },
  parse_mode: "HTML"
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot Active!');

  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken && incomingSecret !== secretToken) {
    return res.status(403).send('Forbidden');
  }

  const update = req.body;
  if (!update || !update.update_id) return res.status(200).send('OK');

  const updateKey = `processed_update:${update.update_id}`;
  const isProcessed = await redis.set(updateKey, '1', { nx: true, ex: 86400 });
  if (!isProcessed) return res.status(200).send('OK');

  // --- HANDLER CALLBACK QUERY (Tombol Klik) ---
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id.toString();
    const action = cb.data;

    await bot.answerCallbackQuery(cb.id);
    const partnerId = await redis.hget(PAIRS_HASH, chatId);

    if (action === 'cmd_random') {
      await handleRandomMatch(chatId, partnerId);
    } else if (action === 'cmd_cancel_queue') {
      await handleCancelQueue(chatId);
    } else if (action === 'cmd_stop') {
      await handleStopChat(chatId, partnerId);
    } else if (action === 'cmd_next') {
      if (partnerId) {
        // Hapus semua riwayat pesan antara kedua user sebelum memutus koneksi
        await clearChatHistory(chatId, partnerId);
        await cleanupPair(chatId, partnerId);

        await bot.sendMessage(chatId, "🔄 <i>Obrolan dihentikan & pesan dibersihkan. Mencari teman baru...</i>", { parse_mode: "HTML" });
        await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan. Pesan telah dibersihkan.</i>", MAIN_KEYBOARD);
      } else {
        await handleCancelQueue(chatId);
      }
      await handleRandomMatch(chatId, null);
    }
    return res.status(200).send('OK');
  }

  // --- HANDLER MESSAGE ---
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return res.status(200).send('OK');

  const chatId = msg.chat.id.toString();
  const text = msg.text || '';
  const partnerId = await redis.hget(PAIRS_HASH, chatId);

  if (text === '/start') {
    const welcomeMsg = 
      "✨ <b>Selamat Datang di AnonChat Bot!</b> ✨\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      "Ngobrol rahasia & anonim dengan pengguna lain secara acak.\n" +
      "💡 <i>Identitas, username, & foto profil kamu dijamin tidak akan terlihat. Pesan otomatis terhapus saat obrolan dihentikan!</i>\n\n" +
      "📌 <b>Panduan & Fitur:</b>\n" +
      "• 🎲 <b>Cari Teman</b> - Mulai mencari obrolan acak\n" +
      "• 🔄 <b>Ganti Pasangan</b> - Pindah ke teman chat lain\n" +
      "• 🛑 <b>Keluar Chat</b> - Mengakhiri obrolan & hapus seluruh riwayat chat\n\n" +
      "👑 <b>Owner Bot:</b> @tatsukiray\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Tekan tombol di bawah untuk mencari pasangan:";
      
    await bot.sendMessage(chatId, welcomeMsg, MAIN_KEYBOARD);
  } else if (text === '/random') {
    await handleRandomMatch(chatId, partnerId);
  } else if (text === '/stop') {
    await handleStopChat(chatId, partnerId);
  } else if (text === '/next') {
    if (partnerId) {
      await clearChatHistory(chatId, partnerId);
      await cleanupPair(chatId, partnerId);

      await bot.sendMessage(chatId, "🔄 <i>Obrolan dihentikan & pesan dibersihkan. Mencari teman baru...</i>", { parse_mode: "HTML" });
      await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan. Pesan telah dibersihkan.</i>", MAIN_KEYBOARD);
    } else {
      await handleCancelQueue(chatId);
    }
    await handleRandomMatch(chatId, null);
  } else {
    if (text.startsWith('/')) return res.status(200).send('OK');

    if (partnerId) {
      try {
        // Simpan message_id pengirim
        await trackMessage(chatId, msg.message_id);

        // Teruskan pesan ke partner
        const copiedMsg = await bot.copyMessage(partnerId, chatId, msg.message_id);

        // Simpan message_id yang diterima partner
        await trackMessage(partnerId, copiedMsg.message_id);
      } catch (err) {
        await clearChatHistory(chatId, partnerId);
        await cleanupPair(chatId, partnerId);
        await bot.sendMessage(chatId, "⚠️ <i>Pasangan memblokir bot/keluar. Obrolan dihentikan.</i>", MAIN_KEYBOARD);
      }
    } else {
      const isWaiting = await redis.sismember(WAITING_SET, chatId);
      if (isWaiting) {
        await bot.sendMessage(chatId, "⏳ <i>Kamu masih dalam antrean pencarian.</i>", QUEUE_KEYBOARD);
      } else {
        await bot.sendMessage(chatId, "⚠️ <i>Kamu belum terhubung dengan siapa pun.</i>", MAIN_KEYBOARD);
      }
    }
  }

  return res.status(200).send('OK');
};

// --- MATCHMAKING LOGIC ---

async function handleRandomMatch(chatId, existingPartnerId) {
  if (existingPartnerId) {
    await bot.sendMessage(chatId, "⚠️ <i>Kamu sedang dalam obrolan aktif!</i>", CHATTING_KEYBOARD);
    return;
  }

  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) return;

  let matchedUser = await redis.spop(WAITING_SET);
  if (matchedUser === chatId) matchedUser = await redis.spop(WAITING_SET);

  if (matchedUser) {
    await redis.hset(PAIRS_HASH, { [chatId]: matchedUser, [matchedUser]: chatId });

    await deleteSearchMessage(matchedUser);

    const matchText = 
      "🎉 <b>Pasangan Ditemukan!</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Silakan menyapa teman barumu. Jaga kesopanan & selamat mengobrol!\n" +
      "🗑️ <i>Semua riwayat chat akan otomatis terhapus saat stop.</i>\n\n" +
      "👑 <i>Bot by @tatsukiray</i>";

    const msg1 = await bot.sendMessage(chatId, matchText, CHATTING_KEYBOARD);
    await trackMessage(chatId, msg1.message_id);
    
    const sent = await notifyUserQuietly(matchedUser, matchText, CHATTING_KEYBOARD);
    if (!sent) {
      await cleanupPair(chatId, matchedUser);
      await bot.sendMessage(chatId, "⚠️ <i>Pasangan tidak merespon/memblokir bot. Mencari ulang...</i>", { parse_mode: "HTML" });
      await handleRandomMatch(chatId, null);
    }
  } else {
    await redis.sadd(WAITING_SET, chatId);

    const searchMsg = await bot.sendMessage(
      chatId, 
      "🔍 <b>Mencari teman obrolan</b> <code>.</code>\n<i>Mohon tunggu sebentar...</i>", 
      QUEUE_KEYBOARD
    );

    await redis.hset(SEARCH_MSG_HASH, { [chatId]: searchMsg.message_id });

    setTimeout(async () => {
      try {
        await bot.editMessageText(
          "🔍 <b>Mencari teman obrolan</b> <code>. .</code>\n<i>Mohon tunggu sebentar...</i>",
          { chat_id: chatId, message_id: searchMsg.message_id, parse_mode: "HTML", ...QUEUE_KEYBOARD }
        );
      } catch (e) {}
    }, 1200);

    setTimeout(async () => {
      try {
        await bot.editMessageText(
          "🔍 <b>Mencari teman obrolan</b> <code>. . .</code>\n<i>Mohon tunggu sebentar...</i>",
          { chat_id: chatId, message_id: searchMsg.message_id, parse_mode: "HTML", ...QUEUE_KEYBOARD }
        );
      } catch (e) {}
    }, 2400);
  }
}

async function handleCancelQueue(chatId) {
  await redis.srem(WAITING_SET, chatId);
  await deleteSearchMessage(chatId);
  await bot.sendMessage(chatId, "❌ <i>Pencarian dibatalkan.</i>", MAIN_KEYBOARD);
}

async function handleStopChat(chatId, partnerId) {
  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) {
    await handleCancelQueue(chatId);
    return;
  }

  if (!partnerId) {
    await bot.sendMessage(chatId, "⚠️ <i>Kamu sedang tidak dalam obrolan.</i>", MAIN_KEYBOARD);
    return;
  }

  // Hapus semua riwayat percakapan kedua user
  await clearChatHistory(chatId, partnerId);
  await cleanupPair(chatId, partnerId);

  await bot.sendMessage(chatId, "🛑 <b>Obrolan Dihentikan.</b>\nSemua riwayat percakapan telah dibersihkan.", MAIN_KEYBOARD);
  await notifyUserQuietly(partnerId, "🛑 <b>Teman bicara kamu telah menghentikan obrolan.</b>\nSemua riwayat percakapan telah dibersihkan.", MAIN_KEYBOARD);
}

// --- HELPER UNTUK TRACKING & PENGHAPUSAN CHAT ---

// Simpan ID Pesan ke Redis List
async function trackMessage(userId, messageId) {
  const key = getChatHistoryKey(userId);
  await redis.rpush(key, messageId);
  await redis.expire(key, 86400); // Expiry 24 jam untuk jaga-jaga
}

// Hapus Seluruh Riwayat Pesan dari Kedua Belah Pihak
async function clearChatHistory(userA, userB) {
  const users = [userA, userB];

  for (const userId of users) {
    const key = getChatHistoryKey(userId);
    const messageIds = await redis.lrange(key, 0, -1);

    if (messageIds && messageIds.length > 0) {
      // Telegram API mendukung penghapusan massal (hingga 100 pesan sekaligus)
      // Jika menggunakan node-telegram-bot-api versi baru, deleteMessages bisa digunakan.
      // Jika versi lama, kita loop secara individual menggunakan deleteMessage.
      for (const msgId of messageIds) {
        try {
          await bot.deleteMessage(userId, parseInt(msgId));
        } catch (e) {
          // Abaikan error jika pesan sudah dihapus manual oleh user
        }
      }
      await redis.del(key);
    }
  }
}

async function deleteSearchMessage(userId) {
  const msgId = await redis.hget(SEARCH_MSG_HASH, userId);
  if (msgId) {
    try {
      await bot.deleteMessage(userId, msgId);
    } catch (e) {}
    await redis.hdel(SEARCH_MSG_HASH, userId);
  }
}

async function cleanupPair(userA, userB) {
  await redis.hdel(PAIRS_HASH, userA, userB);
}

async function notifyUserQuietly(userId, text, keyboard = {}) {
  try {
    const sentMsg = await bot.sendMessage(userId, text, keyboard);
    return sentMsg;
  } catch (err) {
    return false;
  }
}
