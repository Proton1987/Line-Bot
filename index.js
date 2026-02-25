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
  key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config);
const app = express();
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// ✅ แก้จุดนี้: ใช้ Path /ping สำหรับเว็บปลุกโดยเฉพาะ (ไม่ต้องผ่าน line.middleware)
app.get("/ping", (req, res) => {
  res.status(200).send("Bot is Awake!");
});

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

async function saveNewMember(userId, displayName, groupId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });
  } catch (err) {
    console.error("Sheet Save Error");
  }
}

cron.schedule("0 9 * * *", async () => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const today = moment();
    for (let row of rows) {
      if (row.get("Status") === "Active") {
        const joinDateStr = row.get("Join Date");
        if (!joinDateStr) continue;

        const joinDate = moment(joinDateStr);
        const daysDiff = today.diff(joinDate, "days");
        const uId = row.get("User ID");

        if (daysDiff >= 27 && daysDiff < 30) {
          await client.pushMessage(uId, {
            type: "text",
            text: `📢 แจ้งเตือน: อีก ${30 - daysDiff} วันจะหมดอายุสมาชิกค่ะ`,
          }).catch(() => {});
        } else if (daysDiff >= 30) {
          await client.pushMessage(uId, { type: "text", text: `🚫 หมดอายุสมาชิกแล้วค่ะ` }).catch(() => {});
          if (ADMIN_LINE_ID) {
            await client.pushMessage(ADMIN_LINE_ID, {
              type: "text",
              text: `🚨 [หมดอายุ] ${row.get("Display Name")} (${uId})`,
            }).catch(() => {});
          }
          await row.delete();
        }
      }
    }
  } catch (err) {
    console.error("Cron Error");
  }
});

// ✅ Webhook ของ LINE จะรับเฉพาะข้อมูลจาก LINE จริงๆ เท่านั้น
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      // ถ้า Error ตรงนี้ แสดงว่าค่า Config (Secret/Token) ของพี่มีปัญหา
      res.status(500).end();
    });
});

async function handleEvent(event) {
  // กรองเฉพาะ Event ที่มีข้อมูลครบถ้วน
  if (!event || !event.source || !event.source.userId) return null;

  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const isGroup = !!groupId;

  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        let displayName = "สมาชิกใหม่";
        try {
          const profile = await client.getGroupMemberProfile(groupId, member.userId);
          displayName = profile.displayName;
        } catch (e) {}

        await saveNewMember(member.userId, displayName, groupId);

        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.loadCells("A1:K1");

        const img1 = sheet.getCellByA1("F1").value;
        const img2 = sheet.getCellByA1("G1").value;
        const welTxt = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";

        const messages = [];
        if (img1 && img1.toString().startsWith("https")) {
          messages.push({ type: "image", originalContentUrl: img1.toString().trim(), previewImageUrl: img1.toString().trim() });
        }
        if (img2 && img2.toString().startsWith("https")) {
          messages.push({ type: "image", originalContentUrl: img2.toString().trim(), previewImageUrl: img2.toString().trim() });
        }
        messages.push({ type: "text", text: `สวัสดีคุณ ${displayName} ${welTxt}` });

        await client.replyMessage(event.replyToken, messages).catch(() => {});
      } catch (err) {
        console.error("Joined Event Error");
      }
    }
  }

  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      await sheet.loadCells("A1:K1");

      const payTxt = (sheet.getCellByA1("I1").value || "รอแอดมินแจ้งนะคะ").toString().trim();
      const conTxt = (sheet.getCellByA1("J1").value || "รอสักครู่นะคะ").toString().trim();
      const groupRes = (sheet.getCellByA1("K1").value || "ทักแอดมินไวกว่านะคะพี่ 🙏").toString().trim();

      if (isGroup) {
        if (userId !== ADMIN_LINE_ID) {
          await client.replyMessage(event.replyToken, { type: "text", text: groupRes }).catch(() => {});
        }
      } else {
        const payKeyword = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี/g;
        const cleanMsg = userMsg.trim(); 

        if (payKeyword.test(cleanMsg)) {
          await client.replyMessage(event.replyToken, { type: "text", text: payTxt }).catch(() => {});
        } else {
          if (userId !== ADMIN_LINE_ID) {
            await client.replyMessage(event.replyToken, { type: "text", text: conTxt }).catch(() => {});
          }
        }
      }

      if (userId !== ADMIN_LINE_ID && ADMIN_LINE_ID) {
        let name = "สมาชิก";
        try {
          const p = isGroup ? await client.getGroupMemberProfile(groupId, userId) : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}
        await client.pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `📢 มีคนทัก (${isGroup ? 'ในกลุ่ม' : 'ส่วนตัว'})\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Message Processing Error");
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});