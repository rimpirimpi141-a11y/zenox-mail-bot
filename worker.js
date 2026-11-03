/**
 * Zenox Gmail Marketplace & Automated Escrow Bot
 * Runtime: Cloudflare Workers (ES Modules)
 * Storage: Cloudflare KV Namespace bound as `env.DB` (ID: 6c0887279ba94d15ab351985d495ad41)
 */

const DEFAULT_ENV = {
  BOT_TOKEN: "9163966381:AAG5PDtOmSN_we116QgDF8fX_8JhLu6QTxM",
  OWNER_ID: "8838351233",
  SUPPORT_USERNAME: "@ZenoxWorker",
  FORCE_CHANNEL: "https://t.me/+ukH5GufIKTthNzA9",
};

const DEFAULT_RATES = {
  buyRate: 22,
  sellRate: 15,
  minWithdraw: 50,
  refBonus: 2,
  usdtRate: 90, // 1 USDT = ₹90
};

const BUTTONS = {
  BUY_GMAIL_PREFIX: "🛒 Buy Gmail",
  SELL_GMAIL_PREFIX: "📥 Sell Gmail",
  WALLET: "💼 My Wallet & Payout",
  ORDERS: "📦 My Orders",
  REFER_PREFIX: "👥 Refer & Earn",
  SETTINGS: "⚙️ Settings",
  UPDATES: "📢 Updates Channel",
  SUPPORT_PREFIX: "💬 Support",
  ADMIN_DASHBOARD: "⚡ Admin Dashboard",
  CANCEL: "❌ Cancel Action",
};

const STATES = {
  IDLE: "IDLE",
  // User States
  AWAITING_BUY_QTY: "AWAITING_BUY_QTY",
  AWAITING_BUY_PROOF: "AWAITING_BUY_PROOF",
  PENDING_BUY_APPROVAL: "PENDING_BUY_APPROVAL",
  AWAITING_SELL_CREDS: "AWAITING_SELL_CREDS",
  AWAITING_WITHDRAW_DETAILS: "AWAITING_WITHDRAW_DETAILS",
  // Admin States (Tracked in `user:${admin_id}:state`)
  ADMIN_ADD_STOCK: "ADMIN_ADD_STOCK",
  ADMIN_REMOVE_STOCK_ITEM: "ADMIN_REMOVE_STOCK_ITEM",
  ADMIN_INSPECT_USER: "ADMIN_INSPECT_USER",
  ADMIN_USER_ADD_BAL: "ADMIN_USER_ADD_BAL",
  ADMIN_USER_DED_BAL: "ADMIN_USER_DED_BAL",
  ADMIN_SET_RATE_FIELD: "ADMIN_SET_RATE_FIELD",
  ADMIN_SET_PAYMENT_CONFIG: "ADMIN_SET_PAYMENT_CONFIG",
  ADMIN_SET_FORCE_CHANNEL: "ADMIN_SET_FORCE_CHANNEL",
  ADMIN_ADD_ADMIN: "ADMIN_ADD_ADMIN",
  ADMIN_REMOVE_ADMIN: "ADMIN_REMOVE_ADMIN",
  ADMIN_BROADCAST: "ADMIN_BROADCAST",
  ADMIN_REJECT_BUY_NOTE: "ADMIN_REJECT_BUY_NOTE",
  ADMIN_REJECT_SELL_NOTE: "ADMIN_REJECT_SELL_NOTE",
  ADMIN_APPROVE_WD_PROOF: "ADMIN_APPROVE_WD_PROOF",
  ADMIN_REJECT_WD_NOTE: "ADMIN_REJECT_WD_NOTE",
};

function resolveEnv(env = {}) {
  return {
    ...env,
    BOT_TOKEN: env.BOT_TOKEN || DEFAULT_ENV.BOT_TOKEN,
    OWNER_ID: String(env.OWNER_ID || DEFAULT_ENV.OWNER_ID).trim(),
    SUPPORT_USERNAME: env.SUPPORT_USERNAME || DEFAULT_ENV.SUPPORT_USERNAME,
    FORCE_CHANNEL: env.FORCE_CHANNEL || DEFAULT_ENV.FORCE_CHANNEL,
    DB: env.DB,
  };
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = resolveEnv(rawEnv);
    const url = new URL(request.url);

    // 1. GET /setWebhook — Automatically registers webhook with Telegram API
    if (request.method === "GET" && url.pathname === "/setWebhook") {
      const webhookUrl = `${url.origin}/webhook`;
      const result = await callApi(env, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      return new Response(
        JSON.stringify(
          {
            ok: Boolean(result && result.ok),
            webhook_url: webhookUrl,
            telegram_response: result,
          },
          null,
          2
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. GET / — Health check status
    if (request.method === "GET") {
      return new Response(
        JSON.stringify(
          {
            status: "active",
            bot: "Zenox Gmail Bot Worker",
            kv_bound: Boolean(env.DB),
            setup_webhook_url: `${url.origin}/setWebhook`,
          },
          null,
          2
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. POST / or POST /webhook — Incoming Telegram Updates
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/webhook")) {
      if (!env.DB) {
        return new Response("Missing Cloudflare KV binding 'DB'", { status: 500 });
      }

      let update;
      try {
        const bodyText = await request.text();
        if (!bodyText) return new Response("OK", { status: 200 });
        update = JSON.parse(bodyText);
      } catch {
        return new Response("Bad Request: Invalid JSON", { status: 400 });
      }

      try {
        await handleUpdate(update, env, ctx);
      } catch (err) {
        console.error("Error processing update:", err);
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/* ============================================================================
 * SAFE INTERNAL TELEGRAM API CALLER
 * ========================================================================== */

async function callApi(env, method, payload = {}) {
  if (typeof env.__API_CALLER === "function") {
    return await env.__API_CALLER(method, payload);
  }

  const endpoint = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (error) {
    console.error(`Telegram API error [${method}]:`, error);
    return { ok: false, description: String(error) };
  }
}

/* ============================================================================
 * KV STORAGE & CONFIGURATION HELPERS
 * ========================================================================== */

async function getJson(db, key, defaultValue = null) {
  try {
    const raw = await db.get(key);
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

async function putJson(db, key, value) {
  await db.put(key, JSON.stringify(value));
}

async function getRates(db) {
  const stored = await getJson(db, "system:rates", null);
  if (!stored) {
    await putJson(db, "system:rates", DEFAULT_RATES);
    return { ...DEFAULT_RATES };
  }
  return {
    buyRate: Number(stored.buyRate ?? DEFAULT_RATES.buyRate),
    sellRate: Number(stored.sellRate ?? DEFAULT_RATES.sellRate),
    minWithdraw: Number(stored.minWithdraw ?? DEFAULT_RATES.minWithdraw),
    refBonus: Number(stored.refBonus ?? DEFAULT_RATES.refBonus),
    usdtRate: Number(stored.usdtRate ?? DEFAULT_RATES.usdtRate),
  };
}

async function getPaymentConfig(db, env) {
  const config = await getJson(db, "system:payment_config", null);
  if (config && (config.upiId || config.qrPhotoFileId)) {
    return config;
  }
  if (env.UPI_DETAILS) {
    const seeded = {
      upiId: String(env.UPI_DETAILS).trim(),
      qrImage: null,
      qrPhotoFileId: null,
      updatedAt: new Date().toISOString(),
    };
    await putJson(db, "system:payment_config", seeded);
    return seeded;
  }
  return null;
}

async function getForceChannels(db, env) {
  const stored = await getJson(db, "system:force_channels", null);
  if (stored && Array.isArray(stored.channels)) {
    return stored;
  }
  const initialChannel = (env.FORCE_CHANNEL || "").trim();
  const initial = {
    enabled: Boolean(initialChannel),
    channels: initialChannel ? [initialChannel] : [],
  };
  await putJson(db, "system:force_channels", initial);
  return initial;
}

async function getUserData(db, chatId, fromUser = {}) {
  const key = `user:${chatId}:data`;
  let user = await getJson(db, key, null);
  let isNew = false;

  if (!user) {
    isNew = true;
    user = {
      id: String(chatId),
      firstName: sanitizeText(fromUser.first_name || "User"),
      username: fromUser.username ? `@${sanitizeText(fromUser.username)}` : "None",
      balance: 0,
      totalEarned: 0,
      totalBought: 0,
      totalSold: 0,
      referralCount: 0,
      referredUsers: [],
      referredBy: null,
      referralRewarded: false,
      joinedVerified: false,
      banned: false,
      language: "EN",
      notifications: true,
      currency: "INR",
      orders: [],
      submissions: [],
      withdrawals: [],
      createdAt: new Date().toISOString(),
    };
    await putJson(db, key, user);
    await registerGlobalUser(db, String(chatId));
  } else {
    let mutated = false;
    if (fromUser.first_name && user.firstName !== sanitizeText(fromUser.first_name)) {
      user.firstName = sanitizeText(fromUser.first_name);
      mutated = true;
    }
    const uname = fromUser.username ? `@${sanitizeText(fromUser.username)}` : user.username;
    if (uname !== user.username) {
      user.username = uname;
      mutated = true;
    }
    if (typeof user.totalBought !== "number") {
      user.totalBought = (user.orders || []).length;
      mutated = true;
    }
    if (typeof user.totalSold !== "number") {
      user.totalSold = 0;
      mutated = true;
    }
    if (!Array.isArray(user.referredUsers)) {
      user.referredUsers = [];
      mutated = true;
    }
    if (mutated) {
      await putJson(db, key, user);
    }
  }

  return { user, isNew };
}

async function saveUserData(db, chatId, userData) {
  await putJson(db, `user:${chatId}:data`, userData);
}

async function getUserState(db, chatId) {
  const stateObj = await getJson(db, `user:${chatId}:state`, { state: STATES.IDLE, meta: {} });
  return stateObj || { state: STATES.IDLE, meta: {} };
}

async function setUserState(db, chatId, state, meta = {}) {
  await putJson(db, `user:${chatId}:state`, {
    state,
    meta,
    updatedAt: new Date().toISOString(),
  });
}

async function registerGlobalUser(db, chatId) {
  const users = await getJson(db, "system:users", []);
  const idStr = String(chatId);
  if (!users.includes(idStr)) {
    users.push(idStr);
    await putJson(db, "system:users", users);
  }
}

async function findUserByQuery(db, query) {
  const clean = String(query || "").trim();
  if (!clean) return null;

  const direct = await getJson(db, `user:${clean.replace(/^@/, "")}:data`, null);
  if (direct) return direct;

  const allUsers = await getJson(db, "system:users", []);
  const lower = clean.toLowerCase();
  for (const uid of allUsers) {
    const u = await getJson(db, `user:${uid}:data`, null);
    if (!u) continue;
    if (
      String(u.id) === clean ||
      (u.username && u.username.toLowerCase() === lower) ||
      (u.username && u.username.toLowerCase() === `@${lower}`) ||
      (u.firstName && u.firstName.toLowerCase() === lower)
    ) {
      return u;
    }
  }
  return null;
}

async function getAdmins(db, env) {
  const dynamicAdmins = await getJson(db, "system:admins", []);
  const ownerId = String(env.OWNER_ID || "").trim();
  const set = new Set(dynamicAdmins.map(String));
  if (ownerId) set.add(ownerId);
  return Array.from(set);
}

async function isAdminUser(db, env, chatId) {
  const admins = await getAdmins(db, env);
  return admins.includes(String(chatId));
}

async function getStock(db) {
  return await getJson(db, "stock:gmails", []);
}

async function setStock(db, stockArray) {
  await putJson(db, "stock:gmails", stockArray);
}

async function isMaintenanceMode(db) {
  const flag = await db.get("system:maintenance");
  return flag === "true";
}

async function removeFromList(db, key, itemToRemove) {
  const list = await getJson(db, key, []);
  const filtered = list.filter((item) => String(item) !== String(itemToRemove));
  await putJson(db, key, filtered);
}

/* ============================================================================
 * FORMATTING & KEYBOARD BUILDERS
 * ========================================================================== */

function sanitizeText(input) {
  if (typeof input !== "string") return "";
  return input.replace(/[<>&]/g, (ch) => {
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === "&") return "&amp;";
    return ch;
  });
}

function formatMoney(amountInr, currency = "INR", usdtRate = DEFAULT_RATES.usdtRate) {
  const num = Number(amountInr) || 0;
  if (currency === "USDT") {
    const usdt = (num / (usdtRate || 90)).toFixed(2);
    return `$${usdt} USDT (₹${num})`;
  }
  return `₹${num}`;
}

function generateId(prefix) {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${rand}`;
}

function buildBottomKeyboard(isAdmin, rates = DEFAULT_RATES) {
  const rows = [
    [
      { text: `🛒 Buy Gmail (₹${rates.buyRate})` },
      { text: `📥 Sell Gmail (₹${rates.sellRate})` },
    ],
    [{ text: BUTTONS.WALLET }, { text: BUTTONS.ORDERS }],
    [{ text: `👥 Refer & Earn (₹${rates.refBonus})` }, { text: BUTTONS.SETTINGS }],
    [{ text: BUTTONS.UPDATES }, { text: "💬 Support (@ZenoxWorker)" }],
  ];
  if (isAdmin) {
    rows.push([{ text: BUTTONS.ADMIN_DASHBOARD }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildCancelKeyboard() {
  return {
    keyboard: [[{ text: BUTTONS.CANCEL }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function parseChannelEntry(entry) {
  // Supports "@channel", "-100123456|https://t.me/+invite", or "https://t.me/+invite"
  const raw = String(entry || "").trim();
  if (raw.includes("|")) {
    const [idPart, urlPart] = raw.split("|").map((s) => s.trim());
    return {
      chatId: idPart,
      url: normalizeChannelUrl(urlPart || idPart),
      isInviteUrlOnly: false,
    };
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const isPrivateInvite = raw.includes("/+") || raw.includes("joinchat/");
    if (isPrivateInvite) {
      return { chatId: null, url: raw, isInviteUrlOnly: true };
    }
    const handle = raw.replace(/^https?:\/\/t\.me\//i, "").split("?")[0];
    return { chatId: `@${handle}`, url: raw, isInviteUrlOnly: false };
  }
  return {
    chatId: raw.startsWith("@") || raw.startsWith("-") ? raw : `@${raw}`,
    url: normalizeChannelUrl(raw),
    isInviteUrlOnly: false,
  };
}

function normalizeChannelUrl(channelHandle) {
  if (!channelHandle) return DEFAULT_ENV.FORCE_CHANNEL;
  const clean = String(channelHandle).trim();
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  if (clean.startsWith("@")) return `https://t.me/${clean.slice(1)}`;
  return `https://t.me/${clean}`;
}

/* ============================================================================
 * FORCE CHANNEL JOIN & REFERRAL SYSTEM
 * ========================================================================== */

async function checkChannelMembership(db, env, user, isCallbackVerify = false) {
  const fcConfig = await getForceChannels(db, env);
  if (!fcConfig.enabled || !fcConfig.channels || fcConfig.channels.length === 0) {
    return true;
  }

  for (const entry of fcConfig.channels) {
    const parsed = parseChannelEntry(entry);

    // If channel is configured strictly as a private invite link (e.g. https://t.me/+ukH5GufIKTthNzA9)
    // without a numeric -100 chat ID, require user to click "Verify Membership" at least once
    if (parsed.isInviteUrlOnly || !parsed.chatId) {
      if (!user.joinedVerified && !isCallbackVerify) {
        return false;
      }
      continue;
    }

    const res = await callApi(env, "getChatMember", {
      chat_id: parsed.chatId,
      user_id: user.id,
    });

    if (!res || !res.ok || !res.result) {
      // If bot is not yet admin in target channel, allow verification on callback tap
      if (!user.joinedVerified && !isCallbackVerify) return false;
      continue;
    }

    const status = res.result.status;
    if (!["creator", "administrator", "member", "restricted"].includes(status)) {
      return false;
    }
  }
  return true;
}

async function sendForceJoinPrompt(db, env, chatId, lang = "EN") {
  const fcConfig = await getForceChannels(db, env);
  const channels = fcConfig.channels.length > 0 ? fcConfig.channels : [DEFAULT_ENV.FORCE_CHANNEL];

  const inlineRows = channels.map((ch, idx) => {
    const parsed = parseChannelEntry(ch);
    return [
      {
        text: `📢 Join Channel ${channels.length > 1 ? `#${idx + 1}` : ""}`.trim(),
        url: parsed.url,
      },
    ];
  });
  inlineRows.push([{ text: "🔄 Verify Membership", callback_data: "verify_join" }]);

  const text =
    lang === "HI"
      ? `⚠️ <b>चैनल ज्वाइन करना अनिवार्य है!</b>\n\nबॉट का उपयोग करने के लिए कृपया हमारे आधिकारिक चैनल को ज्वाइन करें और नीचे <b>🔄 Verify Membership</b> बटन दबाएं।`
      : `⚠️ <b>Mandatory Channel Verification</b>\n\nTo use this bot, you must join our official channel first. Tap <b>📢 Join Channel</b> below and then press <b>🔄 Verify Membership</b>.`;

  await callApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: inlineRows },
  });
}

async function processReferralRewardIfEligible(db, env, user, rates) {
  if (user.referralRewarded || !user.referredBy) return;
  const referrerId = String(user.referredBy);
  if (referrerId === String(user.id)) return;

  const refKey = `user:${referrerId}:data`;
  const referrer = await getJson(db, refKey, null);
  if (!referrer) return;

  const bonus = Number(rates.refBonus || DEFAULT_RATES.refBonus);
  referrer.balance = Number(referrer.balance || 0) + bonus;
  referrer.totalEarned = Number(referrer.totalEarned || 0) + bonus;
  referrer.referralCount = Number(referrer.referralCount || 0) + 1;
  if (!Array.isArray(referrer.referredUsers)) referrer.referredUsers = [];
  if (!referrer.referredUsers.includes(String(user.id))) {
    referrer.referredUsers.push(String(user.id));
  }
  await putJson(db, refKey, referrer);

  user.referralRewarded = true;
  user.joinedVerified = true;
  await saveUserData(db, user.id, user);

  const refLogs = await getJson(db, "system:referrals", []);
  refLogs.unshift({
    referrerId,
    refereeId: user.id,
    amount: bonus,
    timestamp: new Date().toISOString(),
  });
  await putJson(db, "system:referrals", refLogs.slice(0, 200));

  if (referrer.notifications !== false) {
    await callApi(env, "sendMessage", {
      chat_id: referrerId,
      text:
        `🎉 <b>New Referral Verified!</b>\n\n` +
        `User <b>${user.firstName}</b> (<code>${user.id}</code>) joined via your link and verified membership.\n` +
        `💰 <b>+₹${bonus}</b> has been added to your wallet!\n` +
        `🏦 Available Balance: <b>${formatMoney(referrer.balance, referrer.currency, rates.usdtRate)}</b>`,
      parse_mode: "HTML",
    });
  }
}

/* ============================================================================
 * PHOTO-EXACT ADMIN PANEL RENDERER (2x8 Inline Button Grid)
 * ========================================================================== */

async function buildAdminDashboardPayload(db, env) {
  const rates = await getRates(db);
  const stock = await getStock(db);
  const fcConfig = await getForceChannels(db, env);
  const buyUsdt = (rates.buyRate / (rates.usdtRate || 90)).toFixed(2);

  const channelStatus =
    fcConfig.enabled && fcConfig.channels.length > 0
      ? fcConfig.channels.join(", ")
      : "Disabled";

  const text =
    `📊 <b>Live Dynamic Status:</b>\n` +
    `├ ✉️ Buy Rate: ₹${rates.buyRate} (USDT: $${buyUsdt})\n` +
    `├ 📥 Sell Rate: ₹${rates.sellRate}\n` +
    `├ 🎯 Min Withdrawal: ₹${rates.minWithdraw}\n` +
    `├ 👥 Referral Bonus: ₹${rates.refBonus}\n` +
    `├ 📦 Active Stock: ${stock.length} accounts\n` +
    `└ 📢 Force Channels: ${sanitizeText(channelStatus)}\n\n` +
    `👇 <b>Select a management module below:</b>`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "➕ Add Stock", callback_data: "admin:add_stock" },
        { text: "📋 Manage Stock", callback_data: "admin:manage_stock" },
      ],
      [
        { text: "📝 Review Sold Gmails", callback_data: "admin:review_sells" },
        { text: "💳 Manage Payouts", callback_data: "admin:manage_payouts" },
      ],
      [
        { text: "👥 View All Users", callback_data: "admin:view_users" },
        { text: "🔍 Inspect User", callback_data: "admin:inspect_user" },
      ],
      [
        { text: "📊 Real-Time Analytics", callback_data: "admin:analytics" },
        { text: "🎁 Set Rates & Pricing", callback_data: "admin:set_rates" },
      ],
      [
        { text: "💳 Set Admin UPI / QR", callback_data: "admin:set_payment" },
        { text: "📢 Force Channels", callback_data: "admin:force_channels" },
      ],
      [
        { text: "🛡️ Manage Admins", callback_data: "admin:manage_admins" },
        { text: "📣 Broadcast Message", callback_data: "admin:broadcast" },
      ],
      [
        { text: "⚙️ Maintenance Mode", callback_data: "admin:maintenance" },
        { text: "⚠️ Wipe / Reset Data", callback_data: "admin:wipe_data" },
      ],
      [{ text: "🔙 Close Admin Panel", callback_data: "admin:close" }],
    ],
  };

  return { text, reply_markup };
}

async function sendAdminDashboard(db, env, chatId, editMessageId = null) {
  const payload = await buildAdminDashboardPayload(db, env);
  if (editMessageId) {
    await callApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: editMessageId,
      text: payload.text,
      parse_mode: "HTML",
      reply_markup: payload.reply_markup,
    });
  } else {
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: payload.text,
      parse_mode: "HTML",
      reply_markup: payload.reply_markup,
    });
  }
}

/* ============================================================================
 * UPDATE ROUTER & MESSAGE HANDLER
 * ========================================================================== */

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }
  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }
}

async function handleMessage(message, env) {
  const db = env.DB;
  const chatId = String(message.chat.id);
  const fromUser = message.from || {};
  const text = (message.text || message.caption || "").trim();

  const { user, isNew } = await getUserData(db, chatId, fromUser);
  const isAdmin = await isAdminUser(db, env, chatId);
  const rates = await getRates(db);

  // Check if user is banned
  if (user.banned && !isAdmin) {
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `🚫 <b>Access Restricted</b>\n\nYour account has been suspended. Contact ${env.SUPPORT_USERNAME} for support.`,
      parse_mode: "HTML",
    });
    return;
  }

  // Capture referral parameter on /start <ref_id>
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    if (parts.length > 1 && parts[1]) {
      const refCandidate = parts[1].replace(/[^0-9]/g, "");
      if (
        refCandidate &&
        refCandidate !== chatId &&
        !user.referredBy &&
        !user.referralRewarded &&
        (isNew || !user.joinedVerified)
      ) {
        user.referredBy = refCandidate;
        await saveUserData(db, chatId, user);
      }
    }
  }

  // Maintenance Mode Check
  const maintenance = await isMaintenanceMode(db);
  if (maintenance && !isAdmin) {
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        user.language === "HI"
          ? `🔧 <b>सिस्टम मेंटेनेंस</b>\n\nबॉट अभी मेंटेनेंस मोड में है। कृपया कुछ देर बाद प्रयास करें।\nसहायता: ${env.SUPPORT_USERNAME}`
          : `🔧 <b>System Under Maintenance</b>\n\nThe bot is temporarily undergoing scheduled updates. Please try again shortly.\nSupport: ${env.SUPPORT_USERNAME}`,
      parse_mode: "HTML",
    });
    return;
  }

  // Force Channel Join Check (Admins exempt from lockout so they can always manage bot)
  if (!isAdmin) {
    const isJoined = await checkChannelMembership(db, env, user, false);
    if (!isJoined) {
      await sendForceJoinPrompt(db, env, chatId, user.language);
      return;
    }
  }

  if (!user.joinedVerified) {
    user.joinedVerified = true;
    await saveUserData(db, chatId, user);
  }
  await processReferralRewardIfEligible(db, env, user, rates);

  // Global Cancel Command / Button
  if (text === BUTTONS.CANCEL || text === "/cancel") {
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        user.language === "HI"
          ? "✅ वर्तमान प्रक्रिया रद्द कर दी गई है।"
          : "✅ Current operation cancelled. Returned to main menu.",
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });
    return;
  }

  // Detect Top-Level Navigation Buttons
  const isBuyBtn = text.startsWith(BUTTONS.BUY_GMAIL_PREFIX);
  const isSellBtn = text.startsWith(BUTTONS.SELL_GMAIL_PREFIX);
  const isReferBtn = text.startsWith(BUTTONS.REFER_PREFIX);
  const isSupportBtn = text.startsWith(BUTTONS.SUPPORT_PREFIX);

  const isTopLevelNavigation =
    text.startsWith("/start") ||
    text === "/admin" ||
    isBuyBtn ||
    isSellBtn ||
    text === BUTTONS.WALLET ||
    text === BUTTONS.ORDERS ||
    isReferBtn ||
    text === BUTTONS.SETTINGS ||
    text === BUTTONS.UPDATES ||
    isSupportBtn ||
    text === BUTTONS.ADMIN_DASHBOARD;

  if (isTopLevelNavigation) {
    await setUserState(db, chatId, STATES.IDLE, {});
  }

  const stateObj = await getUserState(db, chatId);

  // Route Active Stateful Inputs
  if (!isTopLevelNavigation && stateObj.state && stateObj.state !== STATES.IDLE) {
    await handleStatefulInput(message, user, isAdmin, stateObj, rates, env);
    return;
  }

  // Route Main Menu Commands & Persistent Reply Keyboard
  if (text.startsWith("/start")) {
    const stock = await getStock(db);
    const welcomeText =
      user.language === "HI"
        ? `👋 <b>नमस्ते ${user.firstName}! Zenox Gmail Hub में आपका स्वागत है।</b>\n\n` +
          `🛒 <b>Gmail खरीदें:</b> ₹${rates.buyRate} प्रति अकाउंट\n` +
          `📥 <b>Gmail बेचें:</b> ₹${rates.sellRate} प्रति अकाउंट\n` +
          `👥 <b>रेफरल बोनस:</b> ₹${rates.refBonus} प्रति वेरिफाइड यूजर\n` +
          `📦 <b>उपलब्ध स्टॉक:</b> <code>${stock.length}</code> अकाउंट्स\n\n` +
          `नीचे दिए गए मेनू से अपनी सेवा चुनें:`
        : `👋 <b>Welcome ${user.firstName} to Zenox Gmail Marketplace!</b>\n\n` +
          `🛒 <b>Buy Fresh Gmail:</b> ${formatMoney(rates.buyRate, user.currency, rates.usdtRate)} / account\n` +
          `📥 <b>Sell Your Gmail:</b> ${formatMoney(rates.sellRate, user.currency, rates.usdtRate)} / account\n` +
          `👥 <b>Referral Bonus:</b> ${formatMoney(rates.refBonus, user.currency, rates.usdtRate)} per verified user\n` +
          `📦 <b>Active Stock:</b> <code>${stock.length}</code> accounts\n\n` +
          `Select an option from the bottom keyboard:`;

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: welcomeText,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });
    return;
  }

  // --- BUY GMAIL ---
  if (isBuyBtn) {
    const stock = await getStock(db);
    if (stock.length === 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          user.language === "HI"
            ? `❌ <b>Out of stock!</b> अभी कोई Gmail अकाउंट स्टॉक में उपलब्ध नहीं है।`
            : `❌ <b>Out of stock!</b> No Gmail accounts are currently available. Please check the Updates Channel for restock alerts.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(isAdmin, rates),
      });
      return;
    }

    await setUserState(db, chatId, STATES.AWAITING_BUY_QTY, {});
    const unitPrice = formatMoney(rates.buyRate, user.currency, rates.usdtRate);
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        user.language === "HI"
          ? `🛒 <b>Gmail अकाउंट खरीदें</b>\n\n📦 <b>उपलब्ध स्टॉक:</b> <code>${stock.length}</code> अकाउंट्स\n💵 <b>दर:</b> ${unitPrice} प्रति अकाउंट\n\nकृपया वह संख्या (Quantity) भेजें जितने अकाउंट आप खरीदना चाहते हैं (1 से ${stock.length}):`
          : `🛒 <b>Buy Verified Gmail Accounts</b>\n\n📦 <b>Available Stock:</b> <code>${stock.length}</code> accounts\n💵 <b>Rate:</b> ${unitPrice} per account\n\nPlease enter the <b>quantity</b> of Gmail accounts you want to purchase (<code>1</code> to <code>${stock.length}</code>):`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // --- SELL GMAIL ---
  if (isSellBtn) {
    await setUserState(db, chatId, STATES.AWAITING_SELL_CREDS, {});
    const sellPrice = formatMoney(rates.sellRate, user.currency, rates.usdtRate);
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        user.language === "HI"
          ? `📥 <b>Gmail अकाउंट बेचें (${sellPrice} प्रति अकाउंट)</b>\n\nकृपया अपने Gmail क्रेडेंशियल्स नीचे दिए गए फॉर्मेट में भेजें:\n<code>email@gmail.com:password</code>\nया\n<code>email@gmail.com:password:recovery@email.com</code>`
          : `📥 <b>Sell Your Gmail Account (${sellPrice} / account)</b>\n\nPlease send the account credentials in the format:\n<code>email@gmail.com:password</code>\nor\n<code>email@gmail.com:password:recovery@email.com</code>`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // --- MY WALLET & PAYOUT ---
  if (text === BUTTONS.WALLET) {
    await sendWalletScreen(env, user, rates);
    return;
  }

  // --- MY ORDERS ---
  if (text === BUTTONS.ORDERS) {
    await sendOrdersHistory(db, env, user);
    return;
  }

  // --- REFER & EARN ---
  if (isReferBtn) {
    const botInfoRes = await callApi(env, "getMe", {});
    const botUsername =
      botInfoRes && botInfoRes.ok && botInfoRes.result && botInfoRes.result.username
        ? botInfoRes.result.username
        : "ZenoxGmailBot";
    const refLink = `https://t.me/${botUsername}?start=${chatId}`;
    const bonusStr = formatMoney(rates.refBonus, user.currency, rates.usdtRate);

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👥 <b>Refer & Earn Program (${bonusStr} / Verified User)</b>\n\n` +
        `🔗 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\n` +
        `📊 <b>Total Referrals:</b> <code>${user.referralCount}</code>\n` +
        `💰 <b>Total Referral Earnings:</b> <code>${formatMoney(user.referralCount * rates.refBonus, user.currency, rates.usdtRate)}</code>\n\n` +
        `<i>Share your link! You earn ₹${rates.refBonus} for every friend who joins and verifies channel membership.</i>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });
    return;
  }

  // --- SETTINGS ---
  if (text === BUTTONS.SETTINGS) {
    await sendSettingsMenu(env, user, rates);
    return;
  }

  // --- UPDATES CHANNEL ---
  if (text === BUTTONS.UPDATES) {
    const fcConfig = await getForceChannels(db, env);
    const primaryChannel = fcConfig.channels[0] || env.FORCE_CHANNEL;
    const channelUrl = parseChannelEntry(primaryChannel).url;
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📢 <b>Official Updates Channel</b>\n\nJoin our channel for stock updates, price alerts, and payment proofs:\n👉 ${channelUrl}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "📢 Join Updates Channel", url: channelUrl }]],
      },
    });
    return;
  }

  // --- SUPPORT (@ZenoxWorker) ---
  if (isSupportBtn) {
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `💬 <b>Official Support</b>\n\n` +
        `For any help with orders, payments, or account submissions, contact:\n` +
        `👤 <b>Support:</b> @ZenoxWorker`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "💬 Message @ZenoxWorker", url: "https://t.me/ZenoxWorker" }]],
      },
    });
    return;
  }

  // --- ADMIN DASHBOARD ---
  if (text === BUTTONS.ADMIN_DASHBOARD || text === "/admin") {
    if (!isAdmin) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⛔ Unauthorized access.",
      });
      return;
    }
    await sendAdminDashboard(db, env, chatId);
    return;
  }

  await callApi(env, "sendMessage", {
    chat_id: chatId,
    text: "ℹ️ Please use the bottom reply keyboard to navigate.",
    reply_markup: buildBottomKeyboard(isAdmin, rates),
  });
}

/* ============================================================================
 * STATEFUL INPUT HANDLER
 * ========================================================================== */

async function handleStatefulInput(message, user, isAdmin, stateObj, rates, env) {
  const db = env.DB;
  const chatId = String(message.chat.id);
  const text = (message.text || message.caption || "").trim();
  const { state, meta } = stateObj;

  // 1. BUY FLOW: Quantity Input -> Fetch Dynamic KV Payment Config
  if (state === STATES.AWAITING_BUY_QTY) {
    const qty = parseInt(text, 10);
    const stock = await getStock(db);

    if (isNaN(qty) || qty <= 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Please enter a valid positive number (e.g. <code>1</code>, <code>5</code>).",
        parse_mode: "HTML",
      });
      return;
    }

    if (qty > stock.length) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Only <code>${stock.length}</code> accounts are available in stock. Please enter a quantity between <code>1</code> and <code>${stock.length}</code>:`,
        parse_mode: "HTML",
      });
      return;
    }

    const paymentConfig = await getPaymentConfig(db, env);
    if (!paymentConfig || (!paymentConfig.upiId && !paymentConfig.qrPhotoFileId)) {
      await setUserState(db, chatId, STATES.IDLE, {});
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Admin UPI / QR payment details have not been configured yet. Please contact @ZenoxWorker.",
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(isAdmin, rates),
      });
      return;
    }

    const totalInr = qty * rates.buyRate;
    const totalUsdt = (totalInr / (rates.usdtRate || 90)).toFixed(2);
    const orderId = generateId("ORD");

    await setUserState(db, chatId, STATES.AWAITING_BUY_PROOF, {
      orderId,
      qty,
      totalInr,
      totalUsdt,
    });

    const amountDisplay =
      user.currency === "USDT"
        ? `<b>$${totalUsdt} USDT</b> (₹${totalInr} INR)`
        : `<b>₹${totalInr} INR</b> ($${totalUsdt} USDT)`;

    const invoiceText =
      `🧾 <b>Order Invoice Created</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
      `📦 <b>Quantity:</b> <code>${qty}</code> Gmail Account(s)\n` +
      `💵 <b>Total Amount:</b> ${amountDisplay}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏦 <b>Admin UPI ID:</b> <code>${sanitizeText(paymentConfig.upiId || "See QR Code")}</code>\n` +
      (paymentConfig.qrImage ? `🔗 <b>QR Code Link:</b> ${sanitizeText(paymentConfig.qrImage)}\n` : "") +
      `\n📸 <b>Send Payment Proof:</b> Upload a clear <b>screenshot photo</b> of your payment receipt below.\n` +
      `<i>(Plain-text UTR numbers are not accepted.)</i>`;

    if (paymentConfig.qrPhotoFileId) {
      await callApi(env, "sendPhoto", {
        chat_id: chatId,
        photo: paymentConfig.qrPhotoFileId,
        caption: invoiceText,
        parse_mode: "HTML",
        reply_markup: buildCancelKeyboard(),
      });
    } else {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: invoiceText,
        parse_mode: "HTML",
        reply_markup: buildCancelKeyboard(),
      });
    }
    return;
  }

  // 2. BUY FLOW: Strict Screenshot Upload Verification
  if (state === STATES.AWAITING_BUY_PROOF) {
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    if (!hasPhoto) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Text UTR is not accepted. Please send a clear screenshot of your payment receipt.",
      });
      return;
    }

    const photoFileId = message.photo[message.photo.length - 1].file_id;
    const { orderId, qty, totalInr, totalUsdt } = meta;

    const orderRecord = {
      id: orderId,
      buyerId: chatId,
      buyerName: user.firstName,
      buyerUsername: user.username,
      qty,
      totalInr,
      totalUsdt,
      currency: user.currency,
      caption: sanitizeText(text || "Payment Screenshot"),
      photoFileId,
      status: STATES.PENDING_BUY_APPROVAL,
      createdAt: new Date().toISOString(),
    };

    await putJson(db, `orders:${orderId}`, orderRecord);

    user.orders = [orderId, ...(user.orders || [])].slice(0, 50);
    await saveUserData(db, chatId, user);

    const pendingOrders = await getJson(db, "system:pending_orders", []);
    if (!pendingOrders.includes(orderId)) {
      pendingOrders.push(orderId);
      await putJson(db, "system:pending_orders", pendingOrders);
    }

    await setUserState(db, chatId, STATES.PENDING_BUY_APPROVAL, { lastOrderId: orderId });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `⏳ <b>Screenshot Proof Submitted!</b>\n\n` +
        `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
        `📦 <b>Quantity:</b> <code>${qty}</code> Gmail(s)\n` +
        `💵 <b>Amount:</b> ₹${totalInr} ($${totalUsdt} USDT)\n` +
        `📌 <b>Status:</b> <code>PENDING_BUY_APPROVAL</code>\n\n` +
        `Your payment screenshot has been sent to the admin for verification.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });

    const admins = await getAdmins(db, env);
    const adminCaption =
      `🛒 <b>New Buy Order Payment Receipt</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
      `👤 <b>Buyer ID:</b> <code>${chatId}</code> (${user.firstName} / ${user.username})\n` +
      `💵 <b>Amount:</b> ₹${totalInr} (USDT: $${totalUsdt})\n` +
      `📦 <b>Qty:</b> <code>${qty}</code> account(s)`;

    for (const adminId of admins) {
      await callApi(env, "sendPhoto", {
        chat_id: adminId,
        photo: photoFileId,
        caption: adminCaption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: `✅ Approve Order #${orderId}`, callback_data: `approve_buy:${orderId}` },
              { text: `❌ Reject Order #${orderId}`, callback_data: `reject_buy:${orderId}` },
            ],
          ],
        },
      });
    }
    return;
  }

  if (state === STATES.PENDING_BUY_APPROVAL) {
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `⏳ Your Order <code>${meta.lastOrderId || ""}</code> is awaiting admin verification. Use the bottom keyboard to navigate.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });
    return;
  }

  // 3. SELL FLOW: Account Credentials Input
  if (state === STATES.AWAITING_SELL_CREDS) {
    const cleanCreds = text.trim();
    const parts = cleanCreds.split(":");
    if (parts.length < 2 || !parts[0].includes("@") || parts[1].trim().length < 3) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `❌ <b>Invalid Format!</b>\n\nPlease send credentials in the exact format:\n` +
          `<code>email@gmail.com:password</code>\nor\n<code>email@gmail.com:password:recovery@email.com</code>`,
        parse_mode: "HTML",
      });
      return;
    }

    const formattedCred =
      parts.length >= 3
        ? `${parts[0].trim()}:${parts[1].trim()}:${parts.slice(2).join(":").trim()}`
        : `${parts[0].trim()}:${parts[1].trim()}:none`;

    const subId = generateId("SUB");
    const submission = {
      id: subId,
      sellerId: chatId,
      sellerName: user.firstName,
      sellerUsername: user.username,
      credentials: formattedCred,
      rewardInr: rates.sellRate,
      status: "PENDING_SELL_QUEUE",
      createdAt: new Date().toISOString(),
    };

    await putJson(db, `submissions:${subId}`, submission);
    const pendingQueue = await getJson(db, "system:pending_sells", []);
    if (!pendingQueue.includes(subId)) {
      pendingQueue.push(subId);
      await putJson(db, "system:pending_sells", pendingQueue);
    }

    user.submissions = [subId, ...(user.submissions || [])].slice(0, 50);
    await saveUserData(db, chatId, user);
    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📥 <b>Gmail Submitted to Queue!</b>\n\n` +
        `🆔 <b>Submission ID:</b> <code>${subId}</code>\n` +
        `📧 <b>Account:</b> <code>${sanitizeText(formattedCred)}</code>\n` +
        `💰 <b>Credit on Approval:</b> ₹${rates.sellRate}\n` +
        `📌 <b>Status:</b> <code>PENDING_SELL_QUEUE</code>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });

    const admins = await getAdmins(db, env);
    for (const adminId of admins) {
      await callApi(env, "sendMessage", {
        chat_id: adminId,
        text:
          `📥 <b>New Sold Gmail Submission</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🆔 <b>Submission ID:</b> <code>${subId}</code>\n` +
          `👤 <b>Seller:</b> ${user.firstName} (${user.username}) [<code>${chatId}</code>]\n` +
          `🔑 <b>Credentials:</b> <code>${sanitizeText(formattedCred)}</code>\n` +
          `💵 <b>Sell Rate:</b> ₹${rates.sellRate}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `✅ Approve (₹${rates.sellRate} Credit)`,
                callback_data: `approve_sell:${subId}`,
              },
              { text: "❌ Reject with Note", callback_data: `reject_sell:${subId}` },
            ],
          ],
        },
      });
    }
    return;
  }

  // 4. WITHDRAWAL FLOW: Payout Details Input
  if (state === STATES.AWAITING_WITHDRAW_DETAILS) {
    if (text.length < 4) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Please send valid payout details (UPI ID or USDT TRC20/BEP20 address).",
      });
      return;
    }

    if (user.balance < rates.minWithdraw) {
      await setUserState(db, chatId, STATES.IDLE, {});
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `❌ Minimum withdrawal limit is ₹${rates.minWithdraw}.`,
        reply_markup: buildBottomKeyboard(isAdmin, rates),
      });
      return;
    }

    const amountInr = user.balance;
    const amountUsdt = (amountInr / (rates.usdtRate || 90)).toFixed(2);
    const wdId = generateId("WD");

    user.balance = 0;
    user.withdrawals = [wdId, ...(user.withdrawals || [])].slice(0, 50);
    await saveUserData(db, chatId, user);

    const wdRecord = {
      id: wdId,
      userId: chatId,
      userName: user.firstName,
      userUsername: user.username,
      amountInr,
      amountUsdt,
      currency: user.currency,
      payoutDetails: sanitizeText(text),
      status: "PENDING",
      createdAt: new Date().toISOString(),
    };

    await putJson(db, `withdrawals:${wdId}`, wdRecord);
    const pendingWds = await getJson(db, "system:pending_withdrawals", []);
    pendingWds.push(wdId);
    await putJson(db, "system:pending_withdrawals", pendingWds);

    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `🏧 <b>Withdrawal Request Submitted!</b>\n\n` +
        `🆔 <b>Payout ID:</b> <code>${wdId}</code>\n` +
        `💰 <b>Amount:</b> ₹${amountInr} ($${amountUsdt} USDT)\n` +
        `🏦 <b>Destination:</b> <code>${wdRecord.payoutDetails}</code>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });

    const admins = await getAdmins(db, env);
    for (const adminId of admins) {
      await callApi(env, "sendMessage", {
        chat_id: adminId,
        text:
          `💳 <b>New Withdrawal Request #${wdId}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>User:</b> ${user.firstName} (${user.username}) [<code>${chatId}</code>]\n` +
          `💰 <b>Amount:</b> ₹${amountInr} ($${amountUsdt} USDT)\n` +
          `🏦 <b>Payout Details:</b> <code>${wdRecord.payoutDetails}</code>`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve with Proof", callback_data: `approve_wd:${wdId}` },
              { text: "❌ Reject Refund", callback_data: `reject_wd:${wdId}` },
            ],
          ],
        },
      });
    }
    return;
  }

  // ==========================================================================
  // ADMIN STATEFUL INPUT HANDLERS
  // ==========================================================================
  if (!isAdmin) {
    await setUserState(db, chatId, STATES.IDLE, {});
    return;
  }

  // 5. ADMIN: Add Stock
  if (state === STATES.ADMIN_ADD_STOCK) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes(":") && l.split(":")[0].includes("@"));

    if (lines.length === 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Invalid format. Paste lines as <code>email@gmail.com:password</code> or <code>email@gmail.com:password:recovery</code>",
        parse_mode: "HTML",
      });
      return;
    }

    const stock = await getStock(db);
    let added = 0;
    for (const line of lines) {
      const parts = line.split(":");
      const formatted =
        parts.length >= 3
          ? `${parts[0].trim()}:${parts[1].trim()}:${parts.slice(2).join(":").trim()}`
          : `${parts[0].trim()}:${parts[1].trim()}:none`;
      stock.push(formatted);
      added++;
    }

    await setStock(db, stock);
    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ <b>Stock Added!</b>\n\n➕ Added: <code>${added}</code> accounts\n📦 Total Active Stock: <code>${stock.length}</code> accounts`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    await sendAdminDashboard(db, env, chatId);
    return;
  }

  // 6. ADMIN: Remove Stock Item
  if (state === STATES.ADMIN_REMOVE_STOCK_ITEM) {
    const stock = await getStock(db);
    const query = text.trim().toLowerCase();
    const idx = parseInt(query, 10) - 1;

    let removed = null;
    if (!isNaN(idx) && idx >= 0 && idx < stock.length) {
      removed = stock.splice(idx, 1)[0];
    } else {
      const matchIndex = stock.findIndex((item) => item.toLowerCase().startsWith(query));
      if (matchIndex !== -1) {
        removed = stock.splice(matchIndex, 1)[0];
      }
    }

    await setStock(db, stock);
    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: removed
        ? `🗑️ Removed: <code>${sanitizeText(removed)}</code>\n📦 Remaining Stock: <code>${stock.length}</code>`
        : `⚠️ No matching stock entry found for <code>${sanitizeText(text)}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 7. ADMIN: Set Admin UPI / QR in KV (`system:payment_config`)
  if (state === STATES.ADMIN_SET_PAYMENT_CONFIG) {
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const photoFileId = hasPhoto ? message.photo[message.photo.length - 1].file_id : null;

    const parts = text.split("|").map((s) => s.trim());
    const upiId = parts[0] || (hasPhoto ? "Scan QR Code Above" : "");
    const qrImage = parts[1] || null;

    if (!upiId && !photoFileId) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Send your UPI ID and optional QR URL as <code>merchant@upi | https://qr-link</code> or upload a QR photo with your UPI ID in the caption.",
        parse_mode: "HTML",
      });
      return;
    }

    const newPaymentConfig = {
      upiId,
      qrImage,
      qrPhotoFileId: photoFileId,
      updatedBy: chatId,
      updatedAt: new Date().toISOString(),
    };

    await putJson(db, "system:payment_config", newPaymentConfig);
    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `✅ <b>Admin UPI / QR Updated in KV!</b>\n\n` +
        `🏦 <b>UPI ID:</b> <code>${sanitizeText(upiId)}</code>\n` +
        `🖼️ <b>QR Code:</b> <code>${sanitizeText(qrImage || (photoFileId ? "Telegram QR Photo Saved" : "None"))}</code>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    await sendAdminDashboard(db, env, chatId);
    return;
  }

  // 8. ADMIN: Set Rates & Pricing
  if (state === STATES.ADMIN_SET_RATE_FIELD) {
    const val = parseFloat(text);
    if (isNaN(val) || val < 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Please enter a valid positive number.",
      });
      return;
    }

    const field = meta.field;
    const currentRates = await getRates(db);
    if (field && field in currentRates) {
      currentRates[field] = val;
      await putJson(db, "system:rates", currentRates);
    }

    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Updated <b>${sanitizeText(field)}</b> to <code>${val}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, currentRates),
    });
    await sendAdminRatesMenu(db, env, chatId);
    return;
  }

  // 9. ADMIN: Inspect User
  if (state === STATES.ADMIN_INSPECT_USER) {
    const target = await findUserByQuery(db, text);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!target) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `❌ User <code>${sanitizeText(text)}</code> not found.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    await sendInspectUserCard(env, chatId, target);
    return;
  }

  // 10. ADMIN: Add / Deduct User Balance
  if (state === STATES.ADMIN_USER_ADD_BAL || state === STATES.ADMIN_USER_DED_BAL) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Please enter a valid positive amount.",
      });
      return;
    }

    const targetId = meta.targetUserId;
    const targetUser = await getJson(db, `user:${targetId}:data`, null);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!targetUser) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Target user not found.",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    if (state === STATES.ADMIN_USER_ADD_BAL) {
      targetUser.balance = Number(targetUser.balance || 0) + amount;
      targetUser.totalEarned = Number(targetUser.totalEarned || 0) + amount;
    } else {
      targetUser.balance = Math.max(0, Number(targetUser.balance || 0) - amount);
    }

    await saveUserData(db, targetId, targetUser);

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Updated balance for <code>${targetId}</code>. New Balance: <b>₹${targetUser.balance}</b>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    await sendInspectUserCard(env, chatId, targetUser);
    return;
  }

  // 11. ADMIN: Add Force Channel
  if (state === STATES.ADMIN_SET_FORCE_CHANNEL) {
    const channelInput = text.trim();
    if (!channelInput) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Send a channel username (<code>@Channel</code>), invite URL (<code>https://t.me/+...</code>), or <code>-100chatId|https://t.me/+invite</code>.",
        parse_mode: "HTML",
      });
      return;
    }

    const fcConfig = await getForceChannels(db, env);
    if (!fcConfig.channels.includes(channelInput)) {
      fcConfig.channels.push(channelInput);
    }
    fcConfig.enabled = true;
    await putJson(db, "system:force_channels", fcConfig);
    await setUserState(db, chatId, STATES.IDLE, {});

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Added Force Channel: <code>${sanitizeText(channelInput)}</code>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    await sendAdminForceChannelsMenu(db, env, chatId);
    return;
  }

  // 12. ADMIN: Add / Remove Sub-Admin
  if (state === STATES.ADMIN_ADD_ADMIN) {
    const newAdminId = text.replace(/[^0-9]/g, "");
    if (!newAdminId) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Enter a valid numeric Telegram User ID.",
      });
      return;
    }
    const admins = await getJson(db, "system:admins", []);
    if (!admins.includes(newAdminId)) {
      admins.push(newAdminId);
      await putJson(db, "system:admins", admins);
    }
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Added Sub-Admin <code>${newAdminId}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  if (state === STATES.ADMIN_REMOVE_ADMIN) {
    const targetId = text.replace(/[^0-9]/g, "");
    if (targetId === String(env.OWNER_ID)) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⛔ Cannot remove Primary Owner ID.",
      });
      return;
    }
    const admins = await getJson(db, "system:admins", []);
    await putJson(
      db,
      "system:admins",
      admins.filter((id) => String(id) !== targetId)
    );
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `🗑️ Removed Sub-Admin <code>${targetId}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 13. ADMIN: Broadcast Message
  if (state === STATES.ADMIN_BROADCAST) {
    const allUsers = await getJson(db, "system:users", []);
    await setUserState(db, chatId, STATES.IDLE, {});

    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const photoFileId = hasPhoto ? message.photo[message.photo.length - 1].file_id : null;

    let sent = 0;
    let failed = 0;
    for (const uid of allUsers) {
      let res;
      if (photoFileId) {
        res = await callApi(env, "sendPhoto", {
          chat_id: uid,
          photo: photoFileId,
          caption: `📣 <b>Broadcast</b>\n\n${sanitizeText(text)}`,
          parse_mode: "HTML",
        });
      } else {
        res = await callApi(env, "sendMessage", {
          chat_id: uid,
          text: `📣 <b>Announcement</b>\n\n${sanitizeText(text)}`,
          parse_mode: "HTML",
        });
      }
      if (res && res.ok) sent++;
      else failed++;
    }

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📣 <b>Broadcast Finished!</b>\n\n✅ Delivered: <code>${sent}</code>\n❌ Failed: <code>${failed}</code>`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 14. ADMIN: Reject Buy Order Note
  if (state === STATES.ADMIN_REJECT_BUY_NOTE) {
    const orderId = meta.orderId;
    const order = await getJson(db, `orders:${orderId}`, null);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!order || order.status !== STATES.PENDING_BUY_APPROVAL) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Order <code>${orderId}</code> was already processed.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    order.status = "REJECTED";
    order.rejectionReason = sanitizeText(text);
    order.processedBy = chatId;
    order.processedAt = new Date().toISOString();
    await putJson(db, `orders:${orderId}`, order);
    await removeFromList(db, "system:pending_orders", orderId);

    const buyerState = await getUserState(db, order.buyerId);
    if (buyerState.state === STATES.PENDING_BUY_APPROVAL) {
      await setUserState(db, order.buyerId, STATES.IDLE, {});
    }

    await callApi(env, "sendMessage", {
      chat_id: order.buyerId,
      text:
        `❌ <b>Order #${orderId} Rejected</b>\n\n` +
        `📦 <b>Quantity:</b> <code>${order.qty}</code> Gmail(s)\n` +
        `📝 <b>Reason:</b> <i>${order.rejectionReason}</i>\n\n` +
        `Contact ${env.SUPPORT_USERNAME} if you need assistance.`,
      parse_mode: "HTML",
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Rejection note sent to buyer for Order <code>#${orderId}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 15. ADMIN: Reject Sell Submission Note
  if (state === STATES.ADMIN_REJECT_SELL_NOTE) {
    const subId = meta.subId;
    const sub = await getJson(db, `submissions:${subId}`, null);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!sub || sub.status !== "PENDING_SELL_QUEUE") {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Submission <code>${subId}</code> was already processed.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    sub.status = "REJECTED";
    sub.rejectionReason = sanitizeText(text);
    sub.processedBy = chatId;
    sub.processedAt = new Date().toISOString();
    await putJson(db, `submissions:${subId}`, sub);
    await removeFromList(db, "system:pending_sells", subId);

    await callApi(env, "sendMessage", {
      chat_id: sub.sellerId,
      text:
        `❌ <b>Gmail Submission #${subId} Rejected</b>\n\n` +
        `📧 <b>Account:</b> <code>${sanitizeText(sub.credentials.split(":")[0])}</code>\n` +
        `📝 <b>Reason:</b> <i>${sub.rejectionReason}</i>`,
      parse_mode: "HTML",
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Rejection note forwarded to seller for Submission <code>#${subId}</code>.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 16. ADMIN: Approve Payout with Proof
  if (state === STATES.ADMIN_APPROVE_WD_PROOF) {
    const wdId = meta.wdId;
    const wd = await getJson(db, `withdrawals:${wdId}`, null);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!wd || wd.status !== "PENDING") {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Withdrawal <code>${wdId}</code> was already processed.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const photoFileId = hasPhoto ? message.photo[message.photo.length - 1].file_id : null;
    const proofNote = sanitizeText(text || "Payout Settled");

    wd.status = "PAID";
    wd.payoutProof = proofNote;
    wd.payoutPhotoId = photoFileId;
    wd.processedBy = chatId;
    wd.processedAt = new Date().toISOString();
    await putJson(db, `withdrawals:${wdId}`, wd);
    await removeFromList(db, "system:pending_withdrawals", wdId);

    const userNotice =
      `✅ <b>Withdrawal #${wdId} Paid!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Amount:</b> ₹${wd.amountInr} ($${wd.amountUsdt} USDT)\n` +
      `🏦 <b>Destination:</b> <code>${wd.payoutDetails}</code>\n` +
      `🧾 <b>Proof / Ref:</b> <i>${proofNote}</i>`;

    if (photoFileId) {
      await callApi(env, "sendPhoto", {
        chat_id: wd.userId,
        photo: photoFileId,
        caption: userNotice,
        parse_mode: "HTML",
      });
    } else {
      await callApi(env, "sendMessage", {
        chat_id: wd.userId,
        text: userNotice,
        parse_mode: "HTML",
      });
    }

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Payout <code>#${wdId}</code> marked PAID and proof sent to user.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }

  // 17. ADMIN: Reject & Refund Withdrawal
  if (state === STATES.ADMIN_REJECT_WD_NOTE) {
    const wdId = meta.wdId;
    const wd = await getJson(db, `withdrawals:${wdId}`, null);
    await setUserState(db, chatId, STATES.IDLE, {});

    if (!wd || wd.status !== "PENDING") {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Withdrawal <code>${wdId}</code> was already processed.`,
        parse_mode: "HTML",
        reply_markup: buildBottomKeyboard(true, rates),
      });
      return;
    }

    wd.status = "REJECTED_REFUNDED";
    wd.rejectionReason = sanitizeText(text);
    wd.processedBy = chatId;
    wd.processedAt = new Date().toISOString();
    await putJson(db, `withdrawals:${wdId}`, wd);
    await removeFromList(db, "system:pending_withdrawals", wdId);

    const { user: targetUser } = await getUserData(db, wd.userId);
    targetUser.balance = Number(targetUser.balance || 0) + Number(wd.amountInr || 0);
    await saveUserData(db, wd.userId, targetUser);

    await callApi(env, "sendMessage", {
      chat_id: wd.userId,
      text:
        `❌ <b>Withdrawal #${wdId} Rejected & Refunded</b>\n\n` +
        `💰 <b>Refunded:</b> ₹${wd.amountInr}\n` +
        `📝 <b>Reason:</b> <i>${wd.rejectionReason}</i>\n` +
        `🏦 <b>Wallet Balance:</b> ₹${targetUser.balance}`,
      parse_mode: "HTML",
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Withdrawal <code>#${wdId}</code> rejected and ₹${wd.amountInr} refunded.`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(true, rates),
    });
    return;
  }
}

/* ============================================================================
 * CALLBACK QUERY HANDLER
 * ========================================================================== */

async function handleCallbackQuery(callbackQuery, env) {
  const db = env.DB;
  const queryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from.id);
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || "";

  const { user } = await getUserData(db, chatId, callbackQuery.from);
  const isAdmin = await isAdminUser(db, env, chatId);
  const rates = await getRates(db);

  // 1. Force Channel Membership Verification
  if (data === "verify_join") {
    const joined = await checkChannelMembership(db, env, user, true);
    if (!joined) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "❌ You have not joined the channel yet! Please join first.",
        show_alert: true,
      });
      return;
    }

    user.joinedVerified = true;
    await saveUserData(db, chatId, user);
    await processReferralRewardIfEligible(db, env, user, rates);

    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "✅ Membership Verified!",
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ <b>Membership Verified!</b>\n\nYou now have full access to the Zenox Gmail Bot. Use the keyboard below:`,
      parse_mode: "HTML",
      reply_markup: buildBottomKeyboard(isAdmin, rates),
    });
    return;
  }

  if (!isAdmin) {
    const joined = await checkChannelMembership(db, env, user, false);
    if (!joined) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Please join our official channel first!",
        show_alert: true,
      });
      await sendForceJoinPrompt(db, env, chatId, user.language);
      return;
    }
  }

  // 2. Request Withdrawal Callback
  if (data === "request_withdrawal") {
    if (Number(user.balance) < rates.minWithdraw) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: `Minimum withdrawal limit is ₹${rates.minWithdraw}`,
        show_alert: true,
      });
      return;
    }

    await setUserState(db, chatId, STATES.AWAITING_WITHDRAW_DETAILS, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `🏧 <b>Request Withdrawal (${formatMoney(user.balance, user.currency, rates.usdtRate)})</b>\n\n` +
        `Please send your <b>Payout Details</b> (UPI ID or USDT TRC20/BEP20 address):`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // 3. Settings Toggles
  if (data === "toggle_lang") {
    user.language = user.language === "HI" ? "EN" : "HI";
    await saveUserData(db, chatId, user);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: user.language === "HI" ? "🌐 भाषा: हिंदी" : "🌐 Language: English",
    });
    await updateSettingsMessage(env, chatId, messageId, user, rates);
    return;
  }

  if (data === "toggle_notif") {
    user.notifications = !user.notifications;
    await saveUserData(db, chatId, user);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `🔔 Notifications: ${user.notifications ? "ON" : "OFF"}`,
    });
    await updateSettingsMessage(env, chatId, messageId, user, rates);
    return;
  }

  if (data === "toggle_currency") {
    user.currency = user.currency === "USDT" ? "INR" : "USDT";
    await saveUserData(db, chatId, user);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `💱 Currency: ${user.currency}`,
    });
    await updateSettingsMessage(env, chatId, messageId, user, rates);
    return;
  }

  // ==========================================================================
  // ADMIN-ONLY CALLBACKS
  // ==========================================================================
  if (!isAdmin) {
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "⛔ Admin access required.",
      show_alert: true,
    });
    return;
  }

  if (data === "admin:panel") {
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await sendAdminDashboard(db, env, chatId, messageId);
    return;
  }

  if (data === "admin:close") {
    await setUserState(db, chatId, STATES.IDLE, {});
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "Closed Admin Panel",
    });
    if (messageId) {
      await callApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "🔒 <b>Admin Panel Closed.</b>",
        parse_mode: "HTML",
      });
    }
    return;
  }

  if (data === "admin:add_stock") {
    await setUserState(db, chatId, STATES.ADMIN_ADD_STOCK, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `➕ <b>Add Gmail Stock</b>\n\n` +
        `Paste multiple lines in format:\n` +
        `<code>email:password</code> or <code>email:password:recovery</code>`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:manage_stock") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const stock = await getStock(db);
    const preview =
      stock.length === 0
        ? "<i>No active stock in KV.</i>"
        : stock
            .slice(0, 15)
            .map((item, i) => `${i + 1}. <code>${sanitizeText(item)}</code>`)
            .join("\n") + (stock.length > 15 ? `\n<i>...and ${stock.length - 15} more</i>` : "");

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📋 <b>Active Stock (${stock.length} accounts)</b>\n━━━━━━━━━━━━━━━━━━━━\n${preview}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ Add Stock", callback_data: "admin:add_stock" },
            { text: "🗑️ Remove Item", callback_data: "admin:remove_stock_item" },
          ],
          [
            { text: "🧹 Clear All Stock", callback_data: "admin:clear_stock_confirm" },
            { text: "🔙 Admin Panel", callback_data: "admin:panel" },
          ],
        ],
      },
    });
    return;
  }

  if (data === "admin:remove_stock_item") {
    await setUserState(db, chatId, STATES.ADMIN_REMOVE_STOCK_ITEM, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🗑️ Send the <b>line number</b> or <b>email address</b> to remove from stock:",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:clear_stock_confirm") {
    await setStock(db, []);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "🧹 Active stock cleared!",
      show_alert: true,
    });
    await sendAdminDashboard(db, env, chatId);
    return;
  }

  if (data === "admin:review_sells") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const pendingSells = await getJson(db, "system:pending_sells", []);
    if (pendingSells.length === 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "✅ <b>No Pending Sold Gmail Submissions!</b>",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Admin Panel", callback_data: "admin:panel" }]],
        },
      });
      return;
    }

    for (const subId of pendingSells.slice(0, 10)) {
      const sub = await getJson(db, `submissions:${subId}`, null);
      if (sub && sub.status === "PENDING_SELL_QUEUE") {
        await callApi(env, "sendMessage", {
          chat_id: chatId,
          text:
            `📝 <b>Submission #${sub.id}</b>\n` +
            `👤 <b>Seller:</b> ${sub.sellerName} (${sub.sellerUsername}) [<code>${sub.sellerId}</code>]\n` +
            `🔑 <b>Credentials:</b> <code>${sanitizeText(sub.credentials)}</code>`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `✅ Approve (₹${sub.rewardInr || rates.sellRate} Credit)`,
                  callback_data: `approve_sell:${sub.id}`,
                },
                { text: "❌ Reject with Note", callback_data: `reject_sell:${sub.id}` },
              ],
            ],
          },
        });
      }
    }
    return;
  }

  if (data === "admin:manage_payouts") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const pendingWds = await getJson(db, "system:pending_withdrawals", []);
    if (pendingWds.length === 0) {
      await callApi(env, "sendMessage", {
        chat_id: chatId,
        text: "✅ <b>No Pending Payout Requests!</b>",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Admin Panel", callback_data: "admin:panel" }]],
        },
      });
      return;
    }

    for (const wdId of pendingWds.slice(0, 10)) {
      const wd = await getJson(db, `withdrawals:${wdId}`, null);
      if (wd && wd.status === "PENDING") {
        await callApi(env, "sendMessage", {
          chat_id: chatId,
          text:
            `💳 <b>Withdrawal #${wd.id}</b>\n` +
            `👤 <b>User:</b> ${wd.userName} (${wd.userUsername}) [<code>${wd.userId}</code>]\n` +
            `💰 <b>Amount:</b> ₹${wd.amountInr} ($${wd.amountUsdt} USDT)\n` +
            `🏦 <b>Destination:</b> <code>${wd.payoutDetails}</code>`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve with Proof", callback_data: `approve_wd:${wd.id}` },
                { text: "❌ Reject Refund", callback_data: `reject_wd:${wd.id}` },
              ],
            ],
          },
        });
      }
    }
    return;
  }

  if (data === "admin:view_users") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const allUsers = await getJson(db, "system:users", []);
    const lines = [`👥 <b>Registered Users (${allUsers.length})</b>\n━━━━━━━━━━━━━━━━━━━━`];

    for (const uid of allUsers.slice(0, 25)) {
      const u = await getJson(db, `user:${uid}:data`, null);
      if (u) {
        lines.push(
          `• <b>${u.firstName}</b> (${u.username}) [<code>${u.id}</code>] — ₹${u.balance} ${u.banned ? "🚫" : "✅"}`
        );
      }
    }

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔍 Inspect User", callback_data: "admin:inspect_user" },
            { text: "🔙 Admin Panel", callback_data: "admin:panel" },
          ],
        ],
      },
    });
    return;
  }

  if (data === "admin:inspect_user") {
    await setUserState(db, chatId, STATES.ADMIN_INSPECT_USER, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🔍 Send the <b>User ID</b> or <b>@username</b> to inspect:",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data.startsWith("admin:user_add_bal:")) {
    const targetUserId = data.split(":")[2];
    await setUserState(db, chatId, STATES.ADMIN_USER_ADD_BAL, { targetUserId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `➕ Enter amount (₹) to <b>ADD</b> to user <code>${targetUserId}</code>:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data.startsWith("admin:user_ded_bal:")) {
    const targetUserId = data.split(":")[2];
    await setUserState(db, chatId, STATES.ADMIN_USER_DED_BAL, { targetUserId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `➖ Enter amount (₹) to <b>DEDUCT</b> from user <code>${targetUserId}</code>:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data.startsWith("admin:user_toggle_ban:")) {
    const targetUserId = data.split(":")[2];
    const targetUser = await getJson(db, `user:${targetUserId}:data`, null);
    if (!targetUser) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "User not found",
        show_alert: true,
      });
      return;
    }
    targetUser.banned = !targetUser.banned;
    await saveUserData(db, targetUserId, targetUser);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: targetUser.banned ? "🚫 User Banned" : "✅ User Unbanned",
    });
    await sendInspectUserCard(env, chatId, targetUser, messageId);
    return;
  }

  if (data === "admin:analytics") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const allUsers = await getJson(db, "system:users", []);
    const stock = await getStock(db);
    const pendingOrders = await getJson(db, "system:pending_orders", []);
    const pendingSells = await getJson(db, "system:pending_sells", []);
    const pendingWds = await getJson(db, "system:pending_withdrawals", []);
    const referrals = await getJson(db, "system:referrals", []);

    let totalBalances = 0;
    let totalBoughtCount = 0;
    let totalSoldCount = 0;
    for (const uid of allUsers) {
      const u = await getJson(db, `user:${uid}:data`, null);
      if (u) {
        totalBalances += Number(u.balance || 0);
        totalBoughtCount += Number(u.totalBought || 0);
        totalSoldCount += Number(u.totalSold || 0);
      }
    }

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📊 <b>Real-Time Analytics</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>Total Users:</b> <code>${allUsers.length}</code>\n` +
        `📦 <b>Active Stock:</b> <code>${stock.length}</code>\n` +
        `🛒 <b>Total Bought by Users:</b> <code>${totalBoughtCount}</code>\n` +
        `📥 <b>Total Sold by Users:</b> <code>${totalSoldCount}</code>\n` +
        `⏳ <b>Pending Buy Approvals:</b> <code>${pendingOrders.length}</code>\n` +
        `⏳ <b>Pending Sell Queue:</b> <code>${pendingSells.length}</code>\n` +
        `💳 <b>Pending Payouts:</b> <code>${pendingWds.length}</code>\n` +
        `💰 <b>Total User Wallet Balances:</b> <code>₹${totalBalances}</code>\n` +
        `🎁 <b>Total Verified Referrals:</b> <code>${referrals.length}</code>`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Admin Panel", callback_data: "admin:panel" }]],
      },
    });
    return;
  }

  if (data === "admin:set_rates") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await sendAdminRatesMenu(db, env, chatId);
    return;
  }

  if (data.startsWith("admin:edit_rate:")) {
    const field = data.split(":")[2];
    await setUserState(db, chatId, STATES.ADMIN_SET_RATE_FIELD, { field });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✏️ Send the new numeric value for <b>${sanitizeText(field)}</b>:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:set_payment") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    const payConfig = await getPaymentConfig(db, env);
    await setUserState(db, chatId, STATES.ADMIN_SET_PAYMENT_CONFIG, {});
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `💳 <b>Set Admin UPI / QR</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏦 <b>Current UPI:</b> <code>${sanitizeText(payConfig?.upiId || "Not Set")}</code>\n` +
        `🖼️ <b>Current QR:</b> <code>${sanitizeText(payConfig?.qrImage || (payConfig?.qrPhotoFileId ? "Telegram QR Photo" : "None"))}</code>\n\n` +
        `Send <code>upi_id@bank | https://qr-image-link</code> OR upload a QR Code photo with your UPI ID as caption:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:force_channels") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await sendAdminForceChannelsMenu(db, env, chatId);
    return;
  }

  if (data === "admin:fc_add") {
    await setUserState(db, chatId, STATES.ADMIN_SET_FORCE_CHANNEL, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📢 Send the channel username (<code>@Channel</code>) or invite URL (<code>https://t.me/+...</code>):",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:fc_toggle") {
    const fcConfig = await getForceChannels(db, env);
    fcConfig.enabled = !fcConfig.enabled;
    await putJson(db, "system:force_channels", fcConfig);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `Force Channels: ${fcConfig.enabled ? "ENABLED" : "DISABLED"}`,
    });
    await sendAdminForceChannelsMenu(db, env, chatId, messageId);
    return;
  }

  if (data === "admin:fc_clear") {
    await putJson(db, "system:force_channels", { enabled: false, channels: [] });
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "Cleared Force Channels",
    });
    await sendAdminForceChannelsMenu(db, env, chatId, messageId);
    return;
  }

  if (data === "admin:manage_admins") {
    const admins = await getAdmins(db, env);
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `🛡️ <b>Manage Admins</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 <b>Owner ID:</b> <code>${env.OWNER_ID}</code>\n` +
        `🛡️ <b>All Admins (${admins.length}):</b>\n` +
        admins.map((id) => `• <code>${id}</code>`).join("\n"),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ Add Sub-Admin", callback_data: "admin:add_subadmin" },
            { text: "🗑️ Remove Sub-Admin", callback_data: "admin:remove_subadmin" },
          ],
          [{ text: "🔙 Admin Panel", callback_data: "admin:panel" }],
        ],
      },
    });
    return;
  }

  if (data === "admin:add_subadmin") {
    await setUserState(db, chatId, STATES.ADMIN_ADD_ADMIN, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "👤 Send the numeric <b>Telegram User ID</b> to add as Sub-Admin:",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:remove_subadmin") {
    await setUserState(db, chatId, STATES.ADMIN_REMOVE_ADMIN, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🗑️ Send the numeric <b>Telegram User ID</b> to remove from Sub-Admins:",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:broadcast") {
    await setUserState(db, chatId, STATES.ADMIN_BROADCAST, {});
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📣 Send the message (text or photo) to broadcast to all users:",
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  if (data === "admin:maintenance") {
    const current = await isMaintenanceMode(db);
    const nextState = !current;
    await db.put("system:maintenance", nextState ? "true" : "false");
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `⚙️ Maintenance Mode: ${nextState ? "ENABLED" : "DISABLED"}`,
      show_alert: true,
    });
    await sendAdminDashboard(db, env, chatId, messageId);
    return;
  }

  if (data === "admin:wipe_data") {
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ <b>Wipe / Reset KV Data</b>\nSelect an action below:",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧹 Clear Active Stock Only", callback_data: "admin:clear_stock_confirm" }],
          [{ text: "⚠️ Clear All Pending Queues", callback_data: "admin:wipe_queues_confirm" }],
          [{ text: "🔙 Cancel", callback_data: "admin:panel" }],
        ],
      },
    });
    return;
  }

  if (data === "admin:wipe_queues_confirm") {
    await putJson(db, "system:pending_orders", []);
    await putJson(db, "system:pending_sells", []);
    await putJson(db, "system:pending_withdrawals", []);
    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "✅ Pending queues cleared!",
      show_alert: true,
    });
    await sendAdminDashboard(db, env, chatId);
    return;
  }

  // APPROVE BUY ORDER
  if (data.startsWith("approve_buy:")) {
    const orderId = data.split(":")[1];
    const order = await getJson(db, `orders:${orderId}`, null);

    if (!order || order.status !== STATES.PENDING_BUY_APPROVAL) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Order already processed.",
        show_alert: true,
      });
      return;
    }

    const stock = await getStock(db);
    if (stock.length < order.qty) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: `❌ Insufficient stock! Need ${order.qty}, have ${stock.length}.`,
        show_alert: true,
      });
      return;
    }

    const allocatedAccounts = stock.splice(0, order.qty);
    await setStock(db, stock);

    order.status = "APPROVED";
    order.deliveredAccounts = allocatedAccounts;
    order.processedBy = chatId;
    order.processedAt = new Date().toISOString();
    await putJson(db, `orders:${orderId}`, order);
    await removeFromList(db, "system:pending_orders", orderId);

    const { user: buyer } = await getUserData(db, order.buyerId);
    buyer.totalBought = Number(buyer.totalBought || 0) + Number(order.qty);
    await saveUserData(db, order.buyerId, buyer);

    const buyerState = await getUserState(db, order.buyerId);
    if (buyerState.state === STATES.PENDING_BUY_APPROVAL) {
      await setUserState(db, order.buyerId, STATES.IDLE, {});
    }

    const monoList = allocatedAccounts.map((acc) => `<code>${sanitizeText(acc)}</code>`).join("\n");

    await callApi(env, "sendMessage", {
      chat_id: order.buyerId,
      text:
        `✅ <b>Order #${orderId} Approved!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>Quantity:</b> <code>${order.qty}</code> Gmail Account(s)\n` +
        `🔑 <b>Accounts (email:password:recovery):</b>\n\n` +
        `${monoList}`,
      parse_mode: "HTML",
    });

    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `✅ Delivered ${order.qty} account(s)!`,
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Approved Order <code>#${orderId}</code> and delivered <code>${order.qty}</code> account(s) to <code>${order.buyerId}</code>.`,
      parse_mode: "HTML",
    });
    return;
  }

  // REJECT BUY ORDER
  if (data.startsWith("reject_buy:")) {
    const orderId = data.split(":")[1];
    const order = await getJson(db, `orders:${orderId}`, null);

    if (!order || order.status !== STATES.PENDING_BUY_APPROVAL) {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Order already processed.",
        show_alert: true,
      });
      return;
    }

    await setUserState(db, chatId, STATES.ADMIN_REJECT_BUY_NOTE, { orderId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📝 Send the rejection reason for Order <code>#${orderId}</code>:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // APPROVE SELL SUBMISSION
  if (data.startsWith("approve_sell:")) {
    const subId = data.split(":")[1];
    const sub = await getJson(db, `submissions:${subId}`, null);

    if (!sub || sub.status !== "PENDING_SELL_QUEUE") {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Submission already processed.",
        show_alert: true,
      });
      return;
    }

    const creditAmount = Number(sub.rewardInr || rates.sellRate);
    const stock = await getStock(db);
    stock.push(sub.credentials);
    await setStock(db, stock);

    const { user: seller } = await getUserData(db, sub.sellerId);
    seller.balance = Number(seller.balance || 0) + creditAmount;
    seller.totalEarned = Number(seller.totalEarned || 0) + creditAmount;
    seller.totalSold = Number(seller.totalSold || 0) + 1;
    await saveUserData(db, sub.sellerId, seller);

    sub.status = "APPROVED";
    sub.processedBy = chatId;
    sub.processedAt = new Date().toISOString();
    await putJson(db, `submissions:${subId}`, sub);
    await removeFromList(db, "system:pending_sells", subId);

    await callApi(env, "sendMessage", {
      chat_id: sub.sellerId,
      text:
        `✅ <b>Submission #${subId} Approved!</b>\n\n` +
        `💰 <b>+₹${creditAmount}</b> has been credited to your wallet.\n` +
        `🏦 <b>Balance:</b> ${formatMoney(seller.balance, seller.currency, rates.usdtRate)}`,
      parse_mode: "HTML",
    });

    await callApi(env, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: `✅ Credited ₹${creditAmount} & added to stock!`,
    });

    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Approved Submission <code>#${subId}</code> (+₹${creditAmount} to <code>${sub.sellerId}</code>).`,
      parse_mode: "HTML",
    });
    return;
  }

  // REJECT SELL SUBMISSION
  if (data.startsWith("reject_sell:")) {
    const subId = data.split(":")[1];
    const sub = await getJson(db, `submissions:${subId}`, null);

    if (!sub || sub.status !== "PENDING_SELL_QUEUE") {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Submission already processed.",
        show_alert: true,
      });
      return;
    }

    await setUserState(db, chatId, STATES.ADMIN_REJECT_SELL_NOTE, { subId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📝 Send the rejection reason for Submission <code>#${subId}</code>:`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // APPROVE WITHDRAWAL
  if (data.startsWith("approve_wd:")) {
    const wdId = data.split(":")[1];
    const wd = await getJson(db, `withdrawals:${wdId}`, null);

    if (!wd || wd.status !== "PENDING") {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Withdrawal already processed.",
        show_alert: true,
      });
      return;
    }

    await setUserState(db, chatId, STATES.ADMIN_APPROVE_WD_PROOF, { wdId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📸 Upload payout proof screenshot or send UTR reference for Withdrawal <code>#${wdId}</code> (₹${wd.amountInr}):`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }

  // REJECT WITHDRAWAL
  if (data.startsWith("reject_wd:")) {
    const wdId = data.split(":")[1];
    const wd = await getJson(db, `withdrawals:${wdId}`, null);

    if (!wd || wd.status !== "PENDING") {
      await callApi(env, "answerCallbackQuery", {
        callback_query_id: queryId,
        text: "⚠️ Withdrawal already processed.",
        show_alert: true,
      });
      return;
    }

    await setUserState(db, chatId, STATES.ADMIN_REJECT_WD_NOTE, { wdId });
    await callApi(env, "answerCallbackQuery", { callback_query_id: queryId });
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text: `📝 Send the rejection reason for Withdrawal <code>#${wdId}</code> (₹${wd.amountInr} will be refunded):`,
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(),
    });
    return;
  }
}

/* ============================================================================
 * UI HELPER SCREENS
 * ========================================================================== */

async function sendInspectUserCard(env, adminChatId, targetUser, editMsgId = null) {
  const joinedDate = targetUser.createdAt ? targetUser.createdAt.split("T")[0] : "Unknown";
  const refList =
    Array.isArray(targetUser.referredUsers) && targetUser.referredUsers.length > 0
      ? targetUser.referredUsers.map((id) => `<code>${id}</code>`).join(", ")
      : "None";

  const text =
    `🔍 <b>User Inspection</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Name:</b> ${targetUser.firstName} (${targetUser.username})\n` +
    `🆔 <b>User ID:</b> <code>${targetUser.id}</code>\n` +
    `📌 <b>Status:</b> ${targetUser.banned ? "🚫 <b>BANNED</b>" : "✅ <b>Active</b>"}\n` +
    `💰 <b>Wallet Balance:</b> <code>₹${targetUser.balance || 0}</code>\n` +
    `🛒 <b>Total Bought:</b> <code>${targetUser.totalBought || 0}</code>\n` +
    `📥 <b>Total Sold:</b> <code>${targetUser.totalSold || 0}</code>\n` +
    `📅 <b>Joined:</b> <code>${joinedDate}</code>\n` +
    `👥 <b>Referred Users (${targetUser.referralCount || 0}):</b> ${refList}`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "➕ Add Balance", callback_data: `admin:user_add_bal:${targetUser.id}` },
        { text: "➖ Deduct Balance", callback_data: `admin:user_ded_bal:${targetUser.id}` },
      ],
      [
        {
          text: targetUser.banned ? "✅ Unban" : "🚫 Ban",
          callback_data: `admin:user_toggle_ban:${targetUser.id}`,
        },
        { text: "🔙 Admin Panel", callback_data: "admin:panel" },
      ],
    ],
  };

  if (editMsgId) {
    await callApi(env, "editMessageText", {
      chat_id: adminChatId,
      message_id: editMsgId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
  } else {
    await callApi(env, "sendMessage", {
      chat_id: adminChatId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
  }
}

async function sendAdminRatesMenu(db, env, chatId) {
  const rates = await getRates(db);
  const buyUsdt = (rates.buyRate / (rates.usdtRate || 90)).toFixed(2);

  await callApi(env, "sendMessage", {
    chat_id: chatId,
    text:
      `🎁 <b>Set Rates & Pricing</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✉️ <b>Buy Rate:</b> ₹${rates.buyRate} (USDT: $${buyUsdt})\n` +
      `📥 <b>Sell Rate:</b> ₹${rates.sellRate}\n` +
      `🎯 <b>Min Withdrawal:</b> ₹${rates.minWithdraw}\n` +
      `👥 <b>Referral Bonus:</b> ₹${rates.refBonus}\n` +
      `💱 <b>USDT Rate:</b> 1 USDT = ₹${rates.usdtRate}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: `✏️ Buy Rate (₹${rates.buyRate})`, callback_data: "admin:edit_rate:buyRate" },
          { text: `✏️ Sell Rate (₹${rates.sellRate})`, callback_data: "admin:edit_rate:sellRate" },
        ],
        [
          {
            text: `✏️ Min Withdraw (₹${rates.minWithdraw})`,
            callback_data: "admin:edit_rate:minWithdraw",
          },
          { text: `✏️ Ref Bonus (₹${rates.refBonus})`, callback_data: "admin:edit_rate:refBonus" },
        ],
        [
          { text: `✏️ USDT Rate (₹${rates.usdtRate})`, callback_data: "admin:edit_rate:usdtRate" },
          { text: "🔙 Admin Panel", callback_data: "admin:panel" },
        ],
      ],
    },
  });
}

async function sendAdminForceChannelsMenu(db, env, chatId, editMsgId = null) {
  const fcConfig = await getForceChannels(db, env);
  const listStr =
    fcConfig.channels.length > 0
      ? fcConfig.channels.map((c) => `• <code>${sanitizeText(c)}</code>`).join("\n")
      : "<i>None</i>";

  const text =
    `📢 <b>Force Channels</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>Status:</b> ${fcConfig.enabled ? "✅ <b>ENABLED</b>" : "❌ <b>DISABLED</b>"}\n` +
    `📋 <b>Channels:</b>\n${listStr}`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "➕ Add Channel", callback_data: "admin:fc_add" },
        {
          text: fcConfig.enabled ? "🔕 Disable" : "🔔 Enable",
          callback_data: "admin:fc_toggle",
        },
      ],
      [
        { text: "🗑️ Clear All", callback_data: "admin:fc_clear" },
        { text: "🔙 Admin Panel", callback_data: "admin:panel" },
      ],
    ],
  };

  if (editMsgId) {
    await callApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
  } else {
    await callApi(env, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
  }
}

async function sendWalletScreen(env, user, rates) {
  const availStr = formatMoney(user.balance, user.currency, rates.usdtRate);
  const earnedStr = formatMoney(user.totalEarned, user.currency, rates.usdtRate);

  const text =
    `💼 <b>My Wallet & Payouts</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Available Balance:</b> <code>${availStr}</code>\n` +
    `📈 <b>Total Earned:</b> <code>${earnedStr}</code>\n` +
    `👥 <b>Referrals:</b> <code>${user.referralCount}</code>\n` +
    `🎯 <b>Min Withdrawal:</b> ₹${rates.minWithdraw}`;

  await callApi(env, "sendMessage", {
    chat_id: user.id,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🏧 Request Withdrawal", callback_data: "request_withdrawal" }]],
    },
  });
}

async function sendOrdersHistory(db, env, user) {
  const orderIds = (user.orders || []).slice(0, 8);
  const subIds = (user.submissions || []).slice(0, 8);

  const lines = [`📦 <b>My Orders & Submissions</b>\n━━━━━━━━━━━━━━━━━━━━`];

  if (orderIds.length === 0 && subIds.length === 0) {
    lines.push("\nNo orders or submissions found.");
  } else {
    if (orderIds.length > 0) {
      lines.push(`\n🛒 <b>Buy Orders:</b>`);
      for (const oid of orderIds) {
        const ord = await getJson(db, `orders:${oid}`, null);
        if (ord) {
          lines.push(`• <code>${ord.id}</code> — ${ord.qty}x Gmail (₹${ord.totalInr}) — <b>${ord.status}</b>`);
        }
      }
    }
    if (subIds.length > 0) {
      lines.push(`\n📥 <b>Sell Submissions:</b>`);
      for (const sid of subIds) {
        const sub = await getJson(db, `submissions:${sid}`, null);
        if (sub) {
          lines.push(`• <code>${sub.id}</code> — ₹${sub.rewardInr} — <b>${sub.status}</b>`);
        }
      }
    }
  }

  await callApi(env, "sendMessage", {
    chat_id: user.id,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

function buildSettingsPayload(user, rates) {
  const langLabel = user.language === "HI" ? "🌐 Language: हिंदी (HI)" : "🌐 Language: English (EN)";
  const notifLabel = user.notifications ? "🔔 Notifications: ON" : "🔔 Notifications: OFF";
  const currLabel = user.currency === "USDT" ? "💱 Currency: USDT ($)" : "💱 Currency: INR (₹)";

  const text = `⚙️ <b>Settings</b>\n\nConfigure your language, notifications, and display currency (1 USDT = ₹${rates.usdtRate}):`;

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: langLabel, callback_data: "toggle_lang" }],
        [{ text: notifLabel, callback_data: "toggle_notif" }],
        [{ text: currLabel, callback_data: "toggle_currency" }],
      ],
    },
  };
}

async function sendSettingsMenu(env, user, rates) {
  const payload = buildSettingsPayload(user, rates);
  await callApi(env, "sendMessage", {
    chat_id: user.id,
    text: payload.text,
    parse_mode: "HTML",
    reply_markup: payload.reply_markup,
  });
}

async function updateSettingsMessage(env, chatId, messageId, user, rates) {
  const payload = buildSettingsPayload(user, rates);
  if (messageId) {
    await callApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: payload.text,
      parse_mode: "HTML",
      reply_markup: payload.reply_markup,
    });
  } else {
    await sendSettingsMenu(env, user, rates);
  }
  }
