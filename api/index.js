const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const token = process.env.BOT_TOKEN;
const secretToken = process.env.TELEGRAM_SECRET_TOKEN;

// Matikan polling karena menggunakan Webhook Serverless
const bot = new TelegramBot(token);

const WAITING_SET = 'waiting_users';
const PAIRS_HASH = 'pairs';
const USERS_SET = 'all_users';

const ADMIN_ID = '8646243735'; // User ID Admin
const QUEUE_TIMEOUT_SECONDS = 60; // Timeout 1 menit

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

  // Anti-duplicate processing (Deduplication)
  const updateKey = `processed_update:${update.update_id}`;
  const isProcessed = await redis.set(updateKey, '1', { nx: true, ex: 86400 });
  if (!isProcessed) return res.status(200).send('OK');

  // --- HANDLER CALLBACK QUERY ---
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id.toString();
    const action = cb.data;
    const messageId = cb.message.message_id;

    await bot.answerCallbackQuery(cb.id);
    const partnerId = await redis.hget(PAIRS_HASH, chatId);

    if (action === 'cmd_random') {
      await handleRandomMatch(chatId, partnerId);
    } else if (action === 'cmd_cancel_queue') {
      await handleCancelQueue(chatId, messageId);
    } else if (action === 'cmd_stop') {
      await handleStopChat(chatId, partnerId, messageId);
    } else if (action === 'cmd_next') {
      if (partnerId) {
        await cleanupPair(chatId, partnerId);
        await bot.sendMessage(chatId, "🔄 <i>Mencari teman baru...</i>", { parse_mode: "HTML" });
        await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan.</i>", MAIN_KEYBOARD);
      } else {
        await removeFromQueue(chatId);
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
    await redis.sadd(USERS_SET, chatId);

    const welcomeMsg = 
      "✨ <b>Selamat Datang di AnonChat Bot!</b> ✨\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      "Ngobrol rahasia & anonim dengan pengguna lain secara acak.\n" +
      "💡 <i>Identitas, username, & foto profil kamu dijamin tidak akan terlihat.</i>\n\n" +
      "📌 <b>Panduan & Fitur:</b>\n" +
      "• 🎲 <b>Cari Teman</b> - Mulai mencari obrolan acak\n" +
      "• 🔄 <b>Ganti Pasangan</b> - Pindah ke teman chat lain\n" +
      "• 🛑 <b>Keluar Chat</b> - Mengakhiri obrolan saat ini\n\n" +
      "👑 <b>Owner Bot:</b> @tatsukiray\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Tekan tombol di bawah untuk mencari pasangan:";
      
    await bot.sendMessage(chatId, welcomeMsg, MAIN_KEYBOARD);
  } else if (text.startsWith('/broad')) {
    if (chatId !== ADMIN_ID) {
      await bot.sendMessage(chatId, "⛔ <i>Fitur ini khusus untuk Owner Bot.</i>", { parse_mode: "HTML" });
      return res.status(200).send('OK');
    }

    const broadcastText = text.replace('/broad', '').trim();
    if (!broadcastText) {
      await bot.sendMessage(chatId, "⚠️ <i>Gunakan format: <code>/broad Teks Pesan</code></i>", { parse_mode: "HTML" });
      return res.status(200).send('OK');
    }

    await handleBroadcast(chatId, broadcastText);
  } else if (text === '/random') {
    await handleRandomMatch(chatId, partnerId);
  } else if (text === '/stop') {
    await handleStopChat(chatId, partnerId, null);
  } else if (text === '/next') {
    if (partnerId) {
      await cleanupPair(chatId, partnerId);
      await bot.sendMessage(chatId, "🔄 <i>Mencari teman baru...</i>", { parse_mode: "HTML" });
      await notifyUserQuietly(partnerId, "🛑 <i>Teman bicara kamu meninggalkan obrolan.</i>", MAIN_KEYBOARD);
    } else {
      await removeFromQueue(chatId);
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
      const isExpired = await checkAndHandleQueueTimeout(chatId);
      if (isExpired) return res.status(200).send('OK');

      const isWaiting = await redis.sismember(WAITING_SET, chatId);
      if (isWaiting) {
        await bot.sendMessage(chatId, "⏳ <i>Kamu masih dalam antrean pencarian...</i>", QUEUE_KEYBOARD);
      } else {
        await bot.sendMessage(chatId, "⚠️ <i>Kamu belum terhubung dengan siapa pun.</i>", MAIN_KEYBOARD);
      }
    }
  }

  return res.status(200).send('OK');
};

// --- BROADCAST LOGIC ---

async function handleBroadcast(adminId, messageText) {
  const allUsers = await redis.smembers(USERS_SET);
  let successCount = 0;
  let failedCount = 0;

  await bot.sendMessage(adminId, `📢 <i>Memulai broadcast ke ${allUsers.length} pengguna...</i>`, { parse_mode: "HTML" });

  const formattedMessage = `📢 <b>PENGUMUMAN</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${messageText}`;

  for (const targetId of allUsers) {
    try {
      await bot.sendMessage(targetId, formattedMessage, { parse_mode: "HTML" });
      successCount++;
    } catch (err) {
      failedCount++;
      if (err.response && (err.response.statusCode === 403 || err.response.statusCode === 400)) {
        await redis.srem(USERS_SET, targetId);
      }
    }
  }

  await bot.sendMessage(
    adminId, 
    `✅ <b>Broadcast Selesai!</b>\n\n• Berhasil: <b>${successCount}</b>\n• Gagal/Diblock: <b>${failedCount}</b>`, 
    { parse_mode: "HTML" }
  );
}

// --- MATCHMAKING & QUEUE TIMEOUT LOGIC ---

async function handleRandomMatch(chatId, existingPartnerId) {
  if (existingPartnerId) {
    await bot.sendMessage(chatId, "⚠️ <i>Kamu sedang dalam obrolan aktif!</i>", CHATTING_KEYBOARD);
    return;
  }

  // Cek apakah antrean sebelumnya sudah kadaluarsa
  await checkAndHandleQueueTimeout(chatId);

  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) {
    await bot.sendMessage(chatId, "⏳ <i>Kamu sudah ada di dalam antrean.</i>", QUEUE_KEYBOARD);
    return;
  }

  let matchedUser = await redis.spop(WAITING_SET);

  // Jika calon pasangan yang ter-pop ternyata antreannya sudah kadaluarsa (> 1 menit)
  while (matchedUser) {
    if (matchedUser === chatId) {
      matchedUser = null;
      break;
    }

    const isMatchedUserExpired = await checkAndHandleQueueTimeout(matchedUser);
    if (!isMatchedUserExpired) {
      break; // Pasangan valid ditemukan
    }

    // Jika kadaluarsa, pop user berikutnya
    matchedUser = await redis.spop(WAITING_SET);
  }

  if (matchedUser) {
    await cleanupQueueTimer(chatId);
    await cleanupQueueTimer(matchedUser);
    await redis.hset(PAIRS_HASH, { [chatId]: matchedUser, [matchedUser]: chatId });

    const matchText = 
      "🎉 <b>Pasangan Ditemukan!</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Silakan menyapa teman barumu. Jaga kesopanan & selamat mengobrol!\n\n" +
      "👑 <i>Bot by @tatsukiray</i>";

    await bot.sendMessage(chatId, matchText, CHATTING_KEYBOARD);
    
    const sent = await notifyUserQuietly(matchedUser, matchText, CHATTING_KEYBOARD);
    if (!sent) {
      await cleanupPair(chatId, matchedUser);
      await bot.sendMessage(chatId, "⚠️ <i>Pasangan tidak merespon/memblokir bot. Mencari ulang...</i>", { parse_mode: "HTML" });
      await handleRandomMatch(chatId, null);
    }
  } else {
    // Masukkan ke antrean dan set Timer TTL 60 detik
    await redis.sadd(WAITING_SET, chatId);
    await redis.set(`queue_timer:${chatId}`, Date.now().toString(), { ex: QUEUE_TIMEOUT_SECONDS });

    await bot.sendMessage(
      chatId, 
      "🔍 <b>Mencari teman obrolan...</b>\n<i>Mohon tunggu sebentar sampai ada pengguna lain (Maks 1 Menit).</i>", 
      QUEUE_KEYBOARD
    );
  }
}

async function checkAndHandleQueueTimeout(chatId) {
  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (!isWaiting) return false;

  const timerExists = await redis.exists(`queue_timer:${chatId}`);
  if (!timerExists) {
    // Timer expired (> 60 detik) -> Otomatis keluarkan dari antrean
    await removeFromQueue(chatId);
    await bot.sendMessage(
      chatId, 
      "⏳ <b>Pencarian Waktu Habis!</b>\n<i>Tidak ada pasangan yang ditemukan dalam 1 menit. Silakan coba cari lagi.</i>", 
      MAIN_KEYBOARD
    );
    return true;
  }
  return false;
}

async function removeFromQueue(chatId) {
  await redis.srem(WAITING_SET, chatId);
  await cleanupQueueTimer(chatId);
}

async function cleanupQueueTimer(chatId) {
  await redis.del(`queue_timer:${chatId}`);
}

async function handleCancelQueue(chatId, messageId = null) {
  await removeFromQueue(chatId);

  if (messageId) {
    try {
      await bot.editMessageText(
        "❌ <b>Pencarian dibatalkan.</b>\nTekan tombol di bawah untuk mencari kembali:",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: MAIN_KEYBOARD.reply_markup
        }
      );
      return;
    } catch (e) {
      // Fallback jika pesan gagal diedit
    }
  }

  await bot.sendMessage(chatId, "❌ <i>Pencarian dibatalkan.</i>", MAIN_KEYBOARD);
}

async function handleStopChat(chatId, partnerId, messageId = null) {
  const isWaiting = await redis.sismember(WAITING_SET, chatId);
  if (isWaiting) {
    await handleCancelQueue(chatId, messageId);
    return;
  }

  if (!partnerId) {
    await bot.sendMessage(chatId, "⚠️ <i>Kamu sedang tidak dalam obrolan.</i>", MAIN_KEYBOARD);
    return;
  }

  await cleanupPair(chatId, partnerId);
  await bot.sendMessage(chatId, "🛑 <b>Obrolan Dihentikan.</b>\nKetik /random atau tekan tombol di bawah untuk mencari lagi.", MAIN_KEYBOARD);
  await notifyUserQuietly(partnerId, "🛑 <b>Teman bicara kamu telah menghentikan obrolan.</b>", MAIN_KEYBOARD);
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
