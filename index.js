const line = require("@line/bot-sdk");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const moment = require("moment");
const cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || "",
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config);
const app = express();
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

let sheetCache = null;

const rateLimit = new Map();

// =============================
// Sheet
// =============================

const getSheet = async () => {
  if (!sheetCache) {
    await doc.loadInfo();
    sheetCache = doc.sheetsByIndex[0];
  }
  return sheetCache;
};

// =============================
// Rate limit
// =============================

function isSpam(userId) {
  const now = Date.now();
  const last = rateLimit.get(userId);

  if (last && now - last < 3000) {
    return true;
  }

  rateLimit.set(userId, now);
  return false;
}

// =============================
// Wake up / Health
// =============================

app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/wake-up", (req, res) => res.status(200).send("Awake"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date(),
  });
});

// =============================
// Member functions
// =============================

async function saveNewMember(userId, displayName, groupId) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();

    const exist = rows.find((r) => r.get("User ID") === userId);

    if (exist) return;

    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });

    if (ADMIN_LINE_ID) {
      await client.pushMessage(ADMIN_LINE_ID, {
        type: "text",
        text: `✅ สมาชิกใหม่\n👤 ${displayName}`,
      });
    }
  } catch (err) {
    console.error("Save member error:", err);
  }
}

async function removeMember(userId) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();

    const row = rows.find((r) => r.get("User ID") === userId);

    if (!row) return;

    const name = row.get("Display Name");

    await row.delete();

    if (ADMIN_LINE_ID) {
      await client.pushMessage(ADMIN_LINE_ID, {
        type: "text",
        text: `🗑️ ลบสมาชิก\n👤 ${name}`,
      });
    }
  } catch (err) {
    console.error("Remove member error:", err);
  }
}

// =============================
// Broadcast
// =============================

async function broadcastMessage(text) {
  const sheet = await getSheet();
  const rows = await sheet.getRows();

  for (const row of rows) {
    if (row.get("Status") !== "Active") continue;

    await client
      .pushMessage(row.get("User ID"), {
        type: "text",
        text: text,
      })
      .catch(() => {});
  }
}

// =============================
// Cron job (ตรวจสมาชิกหมดอายุ)
// =============================

cron.schedule(
  "0 9 * * *",
  async () => {
    try {
      const sheet = await getSheet();
      const rows = await sheet.getRows();

      for (const row of rows) {
        if (row.get("Status") !== "Active") continue;

        const userId = row.get("User ID");
        const groupId = row.get("Group ID");

        const days = moment().diff(moment(row.get("Join Date")), "days");

        if (days >= 30) {
          await client
            .pushMessage(userId, {
              type: "text",
              text: "🚫 สมาชิกหมดอายุแล้ว",
            })
            .catch(() => {});

          if (groupId && groupId !== "Direct Message") {
            await client
              .kickoutFromGroup(groupId, [userId])
              .catch(() => {});
          }

          await removeMember(userId);
        } else if (days >= 27) {
          await client
            .pushMessage(userId, {
              type: "text",
              text: `📢 อีก ${30 - days} วันจะหมดอายุ`,
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error("Cron error:", err);
    }
  },
  {
    timezone: "Asia/Bangkok",
  }
);

// =============================
// Webhook
// =============================

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// =============================
// Event handler
// =============================

async function handleEvent(event) {
  if (!event.source) return null;

  if (event.deliveryContext?.isRedelivery) return null;

  const { userId, groupId } = event.source;

  // =============================
  // Member join
  // =============================

  if (event.type === "memberJoined") {
    for (let m of event.joined.members) {
      let profile;

      try {
        profile = await client.getGroupMemberProfile(groupId, m.userId);
      } catch {
        profile = { displayName: "สมาชิกใหม่" };
      }

      await saveNewMember(m.userId, profile.displayName, groupId);

      const sheet = await getSheet();

      await sheet.loadCells("F1:H1");

      const messages = [];

      ["F1", "G1"].forEach((c) => {
        const url = sheet.getCellByA1(c).value;

        if (url && url.toString().startsWith("http")) {
          messages.push({
            type: "image",
            originalContentUrl: url,
            previewImageUrl: url,
          });
        }
      });

      messages.push({
        type: "text",
        text: `สวัสดี ${profile.displayName}\n${
          sheet.getCellByA1("H1").value || "ยินดีต้อนรับ"
        }`,
      });

      await client.replyMessage(event.replyToken, messages).catch(() => {});
    }
  }

  // =============================
  // Member left
  // =============================

  if (event.type === "memberLeft") {
    for (let m of event.left.members) {
      await removeMember(m.userId);
    }
  }

  // =============================
  // Message
  // =============================

  if (event.type === "message" && event.message.type === "text") {
    if (isSpam(userId)) return null;

    const msg = event.message.text.trim();

    const sheet = await getSheet();

    await sheet.loadCells("I1:J1");

    // =============================
    // Admin command
    // =============================

    if (userId === ADMIN_LINE_ID) {
      if (msg === "/count") {
        const rows = await sheet.getRows();

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `👥 สมาชิกทั้งหมด ${rows.length} คน`,
        });
      }

      if (msg.startsWith("/broadcast")) {
        const text = msg.replace("/broadcast ", "");

        await broadcastMessage(text);

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "📢 ส่ง Broadcast แล้ว",
        });
      }
    }

    // =============================
    // DM auto reply
    // =============================

    if (!groupId) {
      const pay = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี|ช่องทางชำระเงิน/g.test(
        msg
      );

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: pay
          ? sheet.getCellByA1("I1").value || "รอแอดมินแจ้ง"
          : sheet.getCellByA1("J1").value || "รอสักครู่",
      });
    }

    // =============================
    // Forward to admin
    // =============================

    if (ADMIN_LINE_ID && userId !== ADMIN_LINE_ID) {
      const profile = await client
        .getProfile(userId)
        .catch(() => ({ displayName: "ไม่ทราบชื่อ" }));

      await client.pushMessage(ADMIN_LINE_ID, {
        type: "text",
        text: `💬 ข้อความจาก ${profile.displayName}\n${msg.slice(0, 1000)}`,
      });
    }
  }

  return null;
}

// =============================
// Error handler
// =============================

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// =============================
// Start server
// =============================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 LINE BOT RUNNING", PORT);
});
