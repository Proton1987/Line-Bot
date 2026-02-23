const line = require("@line/bot-sdk");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const moment = require("moment");
const cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
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

// ระบบตรวจสอบอายุสมาชิก 27-30 วัน
cron.schedule("0 9 * * *", async () => {
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
        if (daysDiff >= 27 && daysDiff < 30) {
          const remainDays = 30 - daysDiff;
          await client.pushMessage(uId, {
            type: "text",
            text: `📢 แจ้งเตือนคุณ ${uName} อีก ${remainDays} วันจะหมดอายุสมาชิกค่ะ`,
          });
        }
        if (daysDiff >= 30) {
          await client.pushMessage(uId, {
            type: "text",
            text: `🚫 หมดอายุสมาชิกแล้วค่ะคุณ ${uName}`,
          });
          await client.pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `🚨 [หมดอายุ] ${uName} (ID: ${uId})`,
          });
          await row.delete();
        }
      }
    }
  } catch (err) {
    console.error("Cron Error:", err);
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

  // โหลดข้อมูลจาก Sheet ทุกครั้งเพื่อความสดใหม่
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadCells("F1:J1"); // โหลดช่องรูปภาพและข้อความทั้งหมด

  const imgLink1 = sheet.getCellByA1("F1").value || "";
  const imgLink2 = sheet.getCellByA1("G1").value || "";
  const welcomeText =
    sheet.getCellByA1("H1").value || "ยินดีต้อนรับเข้าสู่กลุ่มค่ะ";
  const paymentText =
    sheet.getCellByA1("I1").value ||
    "กรุณารอแอดมินแจ้งรายละเอียดการชำระเงินค่ะ";
  const contactText =
    sheet.getCellByA1("J1").value || "กรุณารอแอดมินตอบกลับนะคะ";

  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        const profile = await client.getGroupMemberProfile(
          groupId,
          member.userId,
        );
        await saveNewMember(member.userId, profile.displayName, groupId);

        const messages = [];
        if (imgLink1.toString().startsWith("http")) {
          messages.push({
            type: "image",
            originalContentUrl: imgLink1,
            previewImageUrl: imgLink1,
          });
        }
        if (imgLink2.toString().startsWith("http")) {
          messages.push({
            type: "image",
            originalContentUrl: imgLink2,
            previewImageUrl: imgLink2,
          });
        }
        // แทรกชื่อลูกค้าเข้าไปในข้อความต้อนรับอัตโนมัติ
        messages.push({
          type: "text",
          text: `สวัสดีคุณ ${profile.displayName} ${welcomeText}`,
        });

        await client.replyMessage(event.replyToken, messages);
      } catch (err) {
        console.error(err);
      }
    }
  }

  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;

    if (userMsg === "สนใจ" || userMsg === "ช่องทางชำระเงิน") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: paymentText,
      });
    } else if (userMsg === "ติดต่อแอดมิด") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: contactText,
      });
    } else {
      if (userId === ADMIN_LINE_ID) return null;
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: contactText,
      });
      await client.pushMessage(ADMIN_LINE_ID, {
        type: "text",
        text: `📢 มีคนทักจากกลุ่ม!\n💬: ${userMsg}`,
      });
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});
