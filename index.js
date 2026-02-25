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

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

async function saveNewMember(userId, displayName, groupId) {
  try {
    console.log(`📝 กำลังบันทึกสมาชิก: ${displayName} (${userId})`);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });
    console.log("✅ บันทึกลง Sheet สำเร็จ!");
  } catch (err) {
    console.error("❌ Sheet Save Error:", err.message);
  }
}

cron.schedule("0 9 * * *", async () => {
  console.log("⏰ เริ่มระบบตรวจสอบอายุสมาชิกรายวัน...");
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
    console.error("❌ Cron Error:", err.message);
  }
});

app.post("/webhook", line.middleware(config), (req, res) => {
  console.log("📩 มี Webhook เข้ามา...");
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("❌ Webhook Middleware Error:", err.message);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (!event.source || !event.source.userId) return null;

  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const isGroup = !!groupId;

  // 1. กรณีคนเข้ากลุ่ม
  if (event.type === "memberJoined") {
    console.log(`🆕 พบสมาชิกเข้ากลุ่ม: ${groupId}`);
    for (let member of event.joined.members) {
      try {
        let displayName = "สมาชิกใหม่";
        try {
          console.log(`🔍 กำลังดึงโปรไฟล์ของ: ${member.userId}`);
          const profile = await client.getGroupMemberProfile(groupId, member.userId);
          displayName = profile.displayName;
          console.log(`👤 ชื่อที่ดึงได้: ${displayName}`);
        } catch (e) {
          console.log("⚠️ ดึงโปรไฟล์ไม่สำเร็จ (อาจยังไม่ได้แอดเพื่อน)");
        }

        await saveNewMember(member.userId, displayName, groupId);

        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        console.log("📄 กำลังโหลด Cells A1:K1 เพื่อดึงข้อมูลต้อนรับ...");
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

        console.log("📤 กำลังส่งข้อความต้อนรับ...");
        await client.replyMessage(event.replyToken, messages);
        console.log("✨ ส่งข้อความต้อนรับสำเร็จ!");
      } catch (err) {
        console.error("❌ Joined Event Error:", err.message);
      }
    }
  }

  // 2. กรณีส่งข้อความ
  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;
    console.log(`💬 ข้อความจาก ${isGroup ? 'กลุ่ม' : 'ส่วนตัว'}: ${userMsg}`);
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      await sheet.loadCells("A1:K1");

      const payTxt = sheet.getCellByA1("I1").value || "รอแอดมินแจ้งนะคะ";
      const conTxt = sheet.getCellByA1("J1").value || "รอสักครู่นะคะ";
      const groupRes = sheet.getCellByA1("K1").value || "ทักแอดมินไวกว่านะคะพี่ 🙏";

      if (isGroup) {
        if (userId !== ADMIN_LINE_ID) {
          console.log("🤖 ตอบกลับอัตโนมัติในกลุ่ม (K1)");
          await client.replyMessage(event.replyToken, { type: "text", text: groupRes.toString() });
        }
      } else {
        if (userMsg === "สนใจ" || userMsg === "ช่องทางชำระเงิน") {
          console.log("🤖 ตอบกลับเลขบัญชี (I1)");
          await client.replyMessage(event.replyToken, { type: "text", text: payTxt.toString() });
        } else if (userMsg === "ติดต่อแอดมิด") {
          console.log("🤖 ตอบกลับติดต่อแอดมิน (J1)");
          await client.replyMessage(event.replyToken, { type: "text", text: conTxt.toString() });
        } else {
          if (userId === ADMIN_LINE_ID) return null;
          console.log("🤖 ตอบกลับ Default (J1)");
          await client.replyMessage(event.replyToken, { type: "text", text: conTxt.toString() });
        }
      }

      if (userId !== ADMIN_LINE_ID && ADMIN_LINE_ID) {
        console.log("📢 กำลังส่งแจ้งเตือนหาแอดมิน...");
        let name = "สมาชิก";
        try {
          const p = isGroup ? await client.getGroupMemberProfile(groupId, userId) : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}

        await client.pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `📢 มีคนทัก (${isGroup ? 'ในกลุ่ม' : 'ส่วนตัว'})\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
        });
      }
    } catch (err) {
      console.error("❌ Message Processing Error:", err.message);
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});