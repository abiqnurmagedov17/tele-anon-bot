const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const token = process.env.BOT_TOKEN;
const secretToken = process.env.TELEGRAM_SECRET_TOKEN;

const bot = new TelegramBot(token);

const WAITING_SET = 'waiting_users';
const PAIRS_HASH = 'pairs';
const SEARCH_MSG_HASH = 'search_msgs'; // Redis Hash untuk simpan ID pesan antrean: { userId: messageId }

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

  // Deduplikasi Update ID
  const updateKey = `processed_update:${update.update_id}`;
  const isProcessed = await redis.set(updateKey, '1', { nx: true, ex: 86400 });
  if (!isProcessed) return res.status(200).send('OK');

  // --- HANDLER 1: CALLBACK QUERY (Klik Tombol Inline) ---
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
        await cleanupPair(chatId, partnerId);
        await bot.sendMessage(chatId, "🔄 <i>Obrolan dihentikan.</i>", { parse_mode: "HTML" });
        await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan.</i>", MAIN_KEYBOARD);
      } else {
        await handleCancelQueue(chatId);
      }
      await handleRandomMatch(chatId, null);
    }
    return res.status(200).send('OK');
  }

  // --- HANDLER 2: MESSAGE (Teks / Media) ---
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return res.status(200).send('OK');

  const chatId = msg.chat.id.toString();
  const text = msg.text || '';
  const partnerId = await redis.hget(PAIRS_HASH, chatId);

  if (text === '/start') {
    const welcomeMsg = 
      "✨ <b>Selamat Datang di AnonChat Bot!</b> ✨\n\n" +
      "Ngobrol rahasia & anonim dengan pengguna lain secara acak.\n" +
      "💡 <i>Identitas & foto profil kamu tidak akan terlihat.</i>\n\n" +
      "Klik tombol di bawah untuk mencari pasangan:";
    await bot.sendMessage(chatId, welcomeMsg, MAIN_KEYBOARD);
  } else if (text === '/random') {
    await handleRandomMatch(chatId, partnerId);
  } else if (text === '/stop') {
    await handleStopChat(chatId, partnerId);
  } else if (text === '/next') {
    if (partnerId) {
      await cleanupPair(chatId, partnerId);
      await bot.sendMessage(chatId, "🔄 <i>Obrolan dihentikan.</i>", { parse_mode: "HTML" });
      await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan.</i>", MAIN_KEYBOARD);
    } else {
      await handleCancelQueue(chatId);
    }
    await handleRandomMatch(chatId, null);
  } else {
    if (text.startsWith('/')) return res.status(200).send('OK');

    if (partnerId) {
      try {
        await bot.copyMessage(partnerId, chatId, msg.message_id);
      } catch (err) {
        await cleanupPair(chatId, partnerId);
        await bot.sendMessage(chatId, "⚠️ <i>Pasangan memblokir bot/keluar. Obrolan dihentikan.</i>", MAIN_KEYBOARD);
      }
    } else {
      const isWaiting = await redis.sismember(WAITING_SET, chatId);
      if (isWaiting) {
        await bot.sendMessage(chatId, "⏳ <i>Kamu masih dalam antrean...</i>", QUEUE_KEYBOARD);
      } else {
        await bot.sendMessage(chatId, "⚠️ <i>Kamu belum terhubung dengan siapa pun.</i>", MAIN_KEYBOARD);
      }
    }
  }

  return res.status(200).send('OK');
};

// --- LOGIKA MATCHMAKING DENGAN ANIMASI & DELETE MESSAGE ---

async function handleRandomMatch(chatId, existingPartnerId) {
  if (existingPartnerId) {
    await bot.sendMessage(chatId, "⚠️ <i>Kamu sedang dalam obrolan aktif!</i>", CHATTING_KEYBOARD);
    return;
  }

  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) {
    return;
  }

  let matchedUser = await redis.spop(WAITING_SET);
  if (matchedUser === chatId) matchedUser = await redis.spop(WAITING_SET);

  if (matchedUser) {
    await redis.hset(PAIRS_HASH, { [chatId]: matchedUser, [matchedUser]: chatId });

    // Hapus pesan "Mencari teman..." milik matchedUser jika ada
    await deleteSearchMessage(matchedUser);

    const matchText = 
      "🎉 <b>Pasangan Ditemukan!</b>\n" +
      "━━━━━━━━━━━━━━━━━━━\n" +
      "Silakan menyapa teman barumu. Jaga kesopanan!\n\n" +
      "<i>Navigasi obrolan:</i>";

    await bot.sendMessage(chatId, matchText, CHATTING_KEYBOARD);
    
    const sent = await notifyUserQuietly(matchedUser, matchText, CHATTING_KEYBOARD);
    if (!sent) {
      await cleanupPair(chatId, matchedUser);
      await bot.sendMessage(chatId, "⚠️ <i>Pasangan tidak merespon/memblokir bot. Mencari ulang...</i>", { parse_mode: "HTML" });
      await handleRandomMatch(chatId, null);
    }
  } else {
    // Masukkan ke antrean
    await redis.sadd(WAITING_SET, chatId);

    // Kirim pesan pencarian awal dengan emoji animasi/loading
    const searchMsg = await bot.sendMessage(
      chatId, 
      "🔍 <b>Mencari teman obrolan</b> <code>.</code>\n<i>Mohon tunggu sebentar...</i>", 
      QUEUE_KEYBOARD
    );

    // Simpan ID pesan agar bisa dihapus saat klik Batal
    await redis.hset(SEARCH_MSG_HASH, { [chatId]: searchMsg.message_id });

    // Efek Animasi Teks (Simulasi titik bergerak secara dramatis)
    // Menggunakan timeout singkat sebelum serverless Vercel membekukan instance
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

// Handler khusus Batal Antre -> HAPUS PESAN PENCARIAN
async function handleCancelQueue(chatId) {
  await redis.srem(WAITING_SET, chatId);
  
  // Hapus pesan "Mencari teman obrolan..." dari layar chat
  await deleteSearchMessage(chatId);

  // Kirim notifikasi baru bahwa antrean telah dibatalkan
  await bot.sendMessage(chatId, "❌ <i>Pencarian dibatalkan.</i>", MAIN_KEYBOARD);
}

// Handler Stop Chat
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

  await cleanupPair(chatId, partnerId);
  await bot.sendMessage(chatId, "🛑 <b>Obrolan Dihentikan.</b>", MAIN_KEYBOARD);
  await notifyUserQuietly(partnerId, "🛑 <b>Teman bicara kamu menghentikan obrolan.</b>", MAIN_KEYBOARD);
}

// Helper untuk Menghapus Pesan Pencarian
async function deleteSearchMessage(userId) {
  const msgId = await redis.hget(SEARCH_MSG_HASH, userId);
  if (msgId) {
    try {
      await bot.deleteMessage(userId, msgId);
    } catch (e) {
      // Abaikan jika pesan sudah terlanjur dihapus user
    }
    await redis.hdel(SEARCH_MSG_HASH, userId);
  }
}

async function cleanupPair(userA, userB) {
  await redis.hdel(PAIRS_HASH, userA, userB);
}

async function notifyUserQuietly(userId, text, keyboard = {}) {
  try {
    await bot.sendMessage(userId, text, keyboard);
    return true;
  } catch (err) {
    return false;
  }
}
