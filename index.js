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

// ------------------------------------------
// 🚀 ประตูสำหรับเว็บปลุก
// ------------------------------------------
app.get("/wake-up", (req, res) => {
  console.log("⏰ [Cron-Job] ได้รับสัญญาณปลุกบอทผ่าน /wake-up");
  res.status(200).send("Bot is Awake! (Internal Wake Up)");
});

app.get("/", (req, res) => {
  console.log("🌐 [Ping] มีคนเข้าหน้าแรก (Root Path)");
  res.status(200).send("OK");
});

async function saveNewMember(userId, displayName, groupId) {
  try {
    console.log(`📝 [Sheet] กำลังเตรียมบันทึกสมาชิก: ${displayName}`);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });
    console.log("✅ [Sheet] บันทึกข้อมูลสมาชิกใหม่สำเร็จ!");
  } catch (err) {
    console.error("❌ [Sheet Error] บันทึกไม่สำเร็จ:", err.message);
  }
}

// ระบบ Cron ตรวจสอบอายุ
cron.schedule("0 9 * * *", async () => {
  console.log("⏰ [Cron] เริ่มทำงานตรวจสอบอายุสมาชิกรายวัน...");
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const today = moment();
    console.log(`📊 [Cron] ตรวจสอบทั้งหมด ${rows.length} รายชื่อ`);
    // ... โค้ดส่วนเช็คอายุสมาชิก ...
  } catch (err) {
    console.error("❌ [Cron Error] ระบบตรวจสอบอายุขัดข้อง:", err.message);
  }
});

// ------------------------------------------
// 🛡️ ประตูสำหรับ LINE Webhook
// ------------------------------------------
app.post("/webhook", line.middleware(config), (req, res) => {
  console.log(
    `📩 [Webhook] ได้รับ Event จาก LINE: ${req.body.events.length} รายการ`,
  );
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(
        "❌ [Middleware Error] ปัญหาที่ Token หรือ Secret:",
        err.message,
      );
      res.status(500).end();
    });
});

async function handleEvent(event) {
  console.log("📦 [Event Data] ข้อมูลดิบ:", JSON.stringify(event));

  if (!event.source || !event.source.userId) {
    console.log("⚠️ [Skip] Event ไม่มีข้อมูล User ID");
    return null;
  }

  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const isGroup = !!groupId;

  // 1. กรณีคนเข้ากลุ่ม
  if (event.type === "memberJoined") {
    console.log(`🆕 [Joined] พบคนเข้ากลุ่ม ID: ${groupId}`);
    for (let member of event.joined.members) {
      try {
        let displayName = "สมาชิกใหม่";
        try {
          console.log(
            `🔍 [Profile] กำลังขอชื่อจาก LINE สำหรับ: ${member.userId}`,
          );
          const profile = await client.getGroupMemberProfile(
            groupId,
            member.userId,
          );
          displayName = profile.displayName;
          console.log(`👤 [Profile] ชื่อที่ได้คือ: ${displayName}`);
        } catch (e) {
          console.log(
            "⚠️ [Profile Fail] ดึงชื่อไม่ได้ (อาจยังไม่แอดเพื่อนบอท)",
          );
        }

        await saveNewMember(member.userId, displayName, groupId);

        console.log("📄 [Sheet] กำลังดึงข้อมูลจาก A1:K1...");
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.loadCells("A1:K1");

        const img1 = sheet.getCellByA1("F1").value;
        const img2 = sheet.getCellByA1("G1").value;
        const welTxt = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";

        const messages = [];
        if (img1 && img1.toString().startsWith("https")) {
          messages.push({
            type: "image",
            originalContentUrl: img1.toString().trim(),
            previewImageUrl: img1.toString().trim(),
          });
        }
        if (img2 && img2.toString().startsWith("https")) {
          messages.push({
            type: "image",
            originalContentUrl: img2.toString().trim(),
            previewImageUrl: img2.toString().trim(),
          });
        }
        messages.push({
          type: "text",
          text: `สวัสดีคุณ ${displayName} ${welTxt}`,
        });

        console.log(`📤 [Reply] กำลังส่งข้อความต้อนรับเข้ากลุ่ม...`);
        await client.replyMessage(event.replyToken, messages);
        console.log("✨ [Success] ส่งข้อความต้อนรับสำเร็จ");
      } catch (err) {
        console.error("❌ [Joined Error] ขั้นตอนเข้ากลุ่มพังที่:", err.message);
      }
    }
  }

  // 2. กรณีส่งข้อความ
  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;
    console.log(
      `💬 [Message] รับข้อความ: "${userMsg}" จาก ${isGroup ? "กลุ่ม" : "ส่วนตัว"}`,
    );

    try {
      console.log("📄 [Sheet] กำลังโหลดค่าจาก I1, J1, K1...");
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      await sheet.loadCells("A1:K1");

      const payTxt = (sheet.getCellByA1("I1").value || "รอแอดมินแจ้งนะคะ")
        .toString()
        .trim();
      const conTxt = (sheet.getCellByA1("J1").value || "รอสักครู่นะคะ")
        .toString()
        .trim();
      const groupRes = (
        sheet.getCellByA1("K1").value || "ทักแอดมินไวกว่านะคะพี่ 🙏"
      )
        .toString()
        .trim();

      if (isGroup) {
        if (userId !== ADMIN_LINE_ID) {
          console.log("🤖 [Response] กำลังตอบกลับในกลุ่ม (K1)");
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: groupRes,
          });
        }
      } else {
        const payKeyword = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี/g;
        if (payKeyword.test(userMsg)) {
          console.log("🤖 [Response] ตอบเรื่องชำระเงิน (I1)");
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: payTxt,
          });
        } else {
          if (userId !== ADMIN_LINE_ID) {
            console.log("🤖 [Response] ตอบเรื่องติดต่อแอดมิน/ทั่วไป (J1)");
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: conTxt,
            });
          }
        }
      }

      // แจ้งเตือนแอดมิน
      if (userId !== ADMIN_LINE_ID && ADMIN_LINE_ID) {
        console.log(`📢 [Admin Alert] กำลังแจ้งแอดมิน (ID: ${ADMIN_LINE_ID})`);
        let name = "สมาชิก";
        try {
          const p = isGroup
            ? await client.getGroupMemberProfile(groupId, userId)
            : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}

        await client.pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `📢 มีคนทัก (${isGroup ? "ในกลุ่ม" : "ส่วนตัว"})\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
        });
        console.log("✅ [Admin Alert] แจ้งเตือนแอดมินสำเร็จ");
      }
    } catch (err) {
      console.error("❌ [Message Error] ขั้นตอนตอบข้อความพังที่:", err.message);
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});
