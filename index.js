const line = require("@line/bot-sdk"), express = require("express"), { GoogleSpreadsheet } = require("google-spreadsheet"), { JWT } = require("google-auth-library"), moment = require("moment"), cron = require("node-cron");

const config = { channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "", channelSecret: process.env.CHANNEL_SECRET || "" };
const SPREADSHEET_ID = process.env.SPREADSHEET_ID, ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;
const serviceAccountAuth = new JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const client = new line.Client(config), app = express(), doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
const getSheet = async () => { await doc.loadInfo(); return doc.sheetsByIndex[0]; };

// --- ฟังก์ชันบันทึกสมาชิก ---
async function saveNewMember(userId, displayName, groupId) {
    try {
        const sheet = await getSheet();
        const bandId = `usr${Math.floor(1000000 + Math.random() * 9000000)}`;
        await sheet.addRow({ "User ID": userId, "Display Name": displayName, "Join Date": moment().format("YYYY-MM-DD"), "Status": "Active", "Group ID": groupId || "DM", "Band ID": bandId });
        if (ADMIN_LINE_ID) client.pushMessage(ADMIN_LINE_ID, { type: "text", text: `✅ [บันทึกใหม่]\n👤: ${displayName}\n🆔 Band: ${bandId}` }).catch(() => {});
        return bandId;
    } catch (err) { console.error("❌ Save Error:", err); }
}

// --- Cron Job ตรวจสอบรายวัน ---
cron.schedule("0 9 * * *", async () => {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    for (let row of rows) {
        if (row.get("Status") !== "Active") continue;
        const daysDiff = moment().diff(moment(row.get("Join Date")), "days");
        if (daysDiff >= 30) {
            if (ADMIN_LINE_ID) client.pushMessage(ADMIN_LINE_ID, { type: "text", text: `🚨 [หมดอายุ - ลบใน BAND]\n👤: ${row.get("Display Name")}\n🆔 Band: ${row.get("Band ID")}` }).catch(() => {});
            await row.delete();
        } else if (daysDiff >= 27) {
            client.pushMessage(row.get("User ID"), { type: "text", text: `📢 อีก ${30 - daysDiff} วันจะหมดอายุสมาชิกค่ะ` }).catch(() => {});
        }
    }
});

app.post("/webhook", line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(() => res.status(500).end());
});

async function handleEvent(event) {
    if (!event.source) return null;
    const { userId, groupId } = event.source;

    // 1. เข้ากลุ่ม
    if (event.type === "memberJoined") {
        for (let m of event.joined.members) {
            let p = await client.getGroupMemberProfile(groupId, m.userId).catch(() => ({ displayName: "สมาชิกใหม่" }));
            const bandId = await saveNewMember(m.userId, p.displayName, groupId);
            const sheet = await getSheet(); await sheet.loadCells("F1:H1");
            const wel = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";
            await client.replyMessage(event.replyToken, { type: "text", text: `สวัสดีคุณ ${p.displayName} ${wel}\n\n📌 ตั้งชื่อในแอป BAND ว่า: ${bandId}` }).catch(() => {});
        }
    }

    // 2. ข้อความ
    if (event.type === "message" && event.message.type === "text") {
        const msg = event.message.text.trim();
        
        // คำสั่ง Admin
        if (userId === ADMIN_LINE_ID && msg.startsWith("!")) {
            const sheet = await getSheet(); await sheet.loadCells("F1:G1");
            if (msg === "!list") {
                const rows = await sheet.getRows();
                let txt = "📋 รายชื่อสมาชิก:\n";
                rows.forEach(r => txt += `👤 ${r.get("Display Name")} | Band: ${r.get("Band ID")}\n`);
                return client.replyMessage(event.replyToken, { type: "text", text: txt });
            }
            if (msg.startsWith("!setimg")) {
                const parts = msg.split(" ");
                sheet.getCellByA1(parts[0] === "!setimg1" ? "F1" : "G1").value = parts[1];
                await sheet.saveUpdatedCells();
                return client.replyMessage(event.replyToken, { type: "text", text: "✅ อัปเดตรูปแล้ว" });
            }
            if (msg === "!generateAllBandID") {
                const rows = await sheet.getRows();
                for (let r of rows) if (!r.get("Band ID")) { r.set("Band ID", `usr${Math.floor(1000000 + Math.random() * 9000000)}`); await r.save(); }
                return client.replyMessage(event.replyToken, { type: "text", text: "✅ สร้าง ID ให้คนเก่าครบแล้ว" });
            }
        }

        // ตอบกลับปกติ
        if (!groupId) {
            const isPay = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี|ช่องทางชำระเงิน/g.test(msg);
            await client.replyMessage(event.replyToken, { type: "text", text: isPay ? "แจ้งเลขบัญชี..." : "ติดต่อแอดมิน..." }).catch(() => {});
        }
    }
}

app.listen(process.env.PORT || 10000);
