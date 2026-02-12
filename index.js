const line = require("@line/bot-sdk");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const moment = require("moment");
const cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN, // ดึงจาก Cloud
  channelSecret: process.env.CHANNEL_SECRET, // ดึงจาก Cloud
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;

// ส่วนของ Google Auth ให้แก้เป็นแบบนี้เพื่อความง่ายบน Cloud
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), // แก้เรื่องบรรทัดใหม่
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config);
const app = express();

const serviceAccountAuth = new JWT({
  email: require("./google-key.json").client_email,
  key: require("./google-key.json").private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// 1. ฟังก์ชันบันทึกสมาชิกใหม่
async function saveNewMember(userId, displayName, groupId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const joinDate = moment().format("YYYY-MM-DD");
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": joinDate,
      Status: "Active",
      "Group ID": groupId,
    });
    console.log(`✅ บันทึกสำเร็จ: ${displayName}`);
  } catch (err) {
    console.error("❌ Save Error:", err.message);
  }
}

// 2. ระบบตรวจสอบอายุสมาชิก (รันทุกวันเวลา 09:00 น.)
// เปลี่ยนเป็น "* * * * *" เพื่อทดสอบได้ครับ
cron.schedule("* * * * *", async () => {
  console.log("🏃 กำลังตรวจสอบรายชื่อสมาชิก...");
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const today = moment();

    for (let row of rows) {
      if (row.get("Status") === "Active") {
        const joinDate = moment(row.get("Join Date"));
        const daysDiff = today.diff(joinDate, "days");
        const uId = row.get("User ID");
        const uName = row.get("Display Name");
        const gId = row.get("Group ID");

        // --- วันที่ 27: แจ้งเตือนล่วงหน้า ---
        if (daysDiff === 27) {
          const msg = `📢 แจ้งเตือนคุณ ${uName}\nอีก 3 วันสมาชิกจะหมดอายุครับ!`;
          try {
            await client.pushMessage(uId, { type: "text", text: msg });
          } catch (e) {}
          if (gId) {
            try {
              await client.pushMessage(gId, {
                type: "text",
                text: `🔔 คุณ ${uName} เหลือเวลาอีก 3 วันครับ`,
              });
            } catch (e) {}
          }
          await client.pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `[ใกล้หมดอายุ] คุณ ${uName} (3 วัน)`,
          });
        }

        // --- วันที่ 30: แจ้งเตือนให้แอดมินเตะ + ลบข้อมูล ---
        if (daysDiff >= 30) {
          const expireMsg = `🚫 หมดเวลาสมาชิกแล้วครับคุณ ${uName}\nขอบคุณที่อยู่ด้วยกันนะครับ`;
          try {
            await client.pushMessage(uId, { type: "text", text: expireMsg });
          } catch (e) {}

          if (gId) {
            try {
              await client.pushMessage(gId, {
                type: "text",
                text: `🚫 คุณ ${uName} หมดอายุสมาชิกแล้วครับ`,
              });
            } catch (e) {}
          }

          // แจ้งแอดมินให้มาเตะออก
          await client.pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `🚨 [หมดอายุ] กรุณาเตะออก 🚨\n👤 ชื่อ: ${uName}\n🆔 ID: ${uId}\n(ระบบลบข้อมูลใน Sheet แล้ว)`,
          });

          // ลบแถวออกจาก Google Sheets ทันที
          await row.delete();
          console.log(`🗑 ลบข้อมูล ${uName} เรียบร้อย`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Cron Error:", err);
  }
});

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) =>
    res.json(result),
  );
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const groupId = event.source.groupId;

  // เมื่อมีคนเข้ากลุ่ม
  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        const profile = await client.getGroupMemberProfile(
          groupId,
          member.userId,
        );
        await saveNewMember(member.userId, profile.displayName, groupId);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `ยินดีต้อนรับคุณ ${profile.displayName}! ระบบเริ่มนับเวลา 30 วันแล้วครับ`,
        });
      } catch (err) {
        console.error(err);
      }
    }
  }

  // เมื่อบอทถูกเชิญเข้ากลุ่มใหม่
  if (event.type === "join") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `สวัสดีครับ! บอทจัดการสมาชิกพร้อมทำงานที่กลุ่มนี้แล้ว\n🆔 ID กลุ่ม: ${groupId}`,
    });
  }

  // เมื่อคนทักข้อความ
  if (event.type === "message" && event.message.type === "text") {
    if (userId === ADMIN_LINE_ID) return null;
    let name = "สมาชิก";
    try {
      const p = await client.getGroupMemberProfile(groupId, userId);
      name = p.displayName;
    } catch (e) {}

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `ทักแอดมินน่ะค่ะ line@ ของแอดมิน: ${LINE_AT_ID}`,
    });
    await client.pushMessage(ADMIN_LINE_ID, {
      type: "text",
      text: `📢 มีคนทักในกลุ่ม!\n👤 ชื่อ: ${name}\n💬: ${event.message.text}`,
    });
  }
}

const PORT = 3000;
app.listen(PORT, () =>
  console.log(`🚀 ระบบ Full System พร้อมทำงานที่พอร์ต ${PORT}`),
);
