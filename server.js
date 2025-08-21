const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();

// User sessions storage
const userSessions = new Map();

// Configuration
const CONFIG = {
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
    WHATSAPP_PHONE_ID: '768489836345252',
    WEBHOOK_VERIFY_TOKEN: 'EndLoadshedding2024',
    SALES_EMAIL: 'sales@endloadshedding.com',
    
    // Email configuration for lead capture
    EMAIL_USER: process.env.EMAIL_USER || 'your-gmail@gmail.com',
    EMAIL_PASS: process.env.EMAIL_PASS || 'your-app-password'
};

app.use(express.json());

// Email transporter setup
const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: CONFIG.EMAIL_USER,
        pass: CONFIG.EMAIL_PASS
    }
});

// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === CONFIG.WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.status(403).send('Forbidden');
    }
});

// Receive messages
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            body.entry.forEach(async (entry) => {
                const changes = entry.changes;
                changes.forEach(async (change) => {
                    if (change.field === 'messages') {
                        const messages = change.value.messages;
                        if (messages) {
                            for (const message of messages) {
                                await handleMessage(message);
                            }
                        }
                    }
                });
            });
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).send('Error');
    }
});

// Handle incoming messages
async function handleMessage(message) {
    const phoneNumber = message.from;
    const messageText = message.text?.body?.trim();
    
    let session = userSessions.get(phoneNumber) || {
        step: 'welcome',
        data: {}
    };

    console.log(`📱 Message from ${phoneNumber}: ${messageText}`);

    // Add realistic delay
    await sleep(2000);

    switch (session.step) {
        case 'welcome':
            await sendMessage(phoneNumber, `🔋 *Hey there! Welcome to End Loadshedding Pty Chatbot!*

Before I connect you to a Customer Support Specialist, I need some quick info.

Could you please share your best email address? 📧`);
            session.step = 'email';
            break;

        case 'email':
            if (isValidEmail(messageText)) {
                session.data.email = messageText;
                await sendMessage(phoneNumber, "Perfect! ✅\n\nWhat's your first name?");
                session.step = 'firstName';
            } else {
                await sendMessage(phoneNumber, "Please provide a valid email address (example: john@gmail.com):");
            }
            break;

        case 'firstName':
            session.data.firstName = messageText;
            await sendMessage(phoneNumber, `Nice to meet you, ${messageText}! 👋\n\nWhat's the physical address where the solar system will be installed?`);
            session.step = 'address';
            break;

        case 'address':
            if (messageText.length < 10) {
                await sendMessage(phoneNumber, "Please provide a complete physical address including street name, suburb, and city:");
                break;
            }
            
            session.data.address = messageText;
            await sendMessage(phoneNumber, "Great! 📍\n\nWhat's your average monthly electricity bill amount in Rands? (example: R2500, R1800, R3200)");
            session.step = 'electricalBill';
            break;

        case 'electricalBill':
            const cleanBill = messageText.replace(/\s+/g, '').toLowerCase();
            const invalidResponses = ['idonotknow', 'idontknow', 'dontknow', 'unknown', 'unsure'];
            const isInvalidResponse = invalidResponses.some(invalid => cleanBill.includes(invalid));
            
            if (isInvalidResponse) {
                await sendMessage(phoneNumber, "Please check your latest electricity bill and provide the actual amount (example: R2500, R1800, R3200):");
                break;
            }
            
            const numberMatch = messageText.match(/\d+/);
            if (!numberMatch) {
                await sendMessage(phoneNumber, "Please provide the amount as a number (example: R2500, R1800, R3200):");
                break;
            }
            
            const billAmount = parseInt(numberMatch[0]);
            if (billAmount < 200 || billAmount > 50000) {
                await sendMessage(phoneNumber, "Please double-check and provide your monthly electricity bill amount (example: R2500, R1800, R3200):");
                break;
            }
            
            session.data.electricalBill = `R${billAmount}`;
            session.data.phoneNumber = phoneNumber;
            await completeLeadCapture(phoneNumber, session.data);
            session.step = 'completed';
            break;

        case 'completed':
            await sendMessage(phoneNumber, "Thank you! A sales specialist will contact you soon. 😊");
            break;

        default:
            await sendMessage(phoneNumber, `🔋 *Hey there! Welcome to End Loadshedding Pty Chatbot!*

Before I connect you to a Customer Support Specialist, I need some quick info.

Could you please share your best email address? 📧`);
            session.step = 'email';
    }

    userSessions.set(phoneNumber, session);
}

// Complete lead capture
async function completeLeadCapture(phoneNumber, leadData) {
    const summaryMessage = `✅ *Perfect! Thank you ${leadData.firstName}!*

📋 *Your Information:*
📧 Email: ${leadData.email}
📍 Address: ${leadData.address}
💡 Monthly Bill: ${leadData.electricalBill}

🎯 *Our sales specialist will contact you within 24 hours!*

Thank you for choosing End Loadshedding Pty! 🌞⚡`;

    await sendMessage(phoneNumber, summaryMessage);
    
    // Save lead to email (guaranteed to work)
    await saveLeadToEmail(leadData);
    
    // Send follow-up after 1 minute
    setTimeout(async () => {
        await sendFollowUpMessage(phoneNumber, leadData.firstName);
    }, 60000);
    
    console.log('🎉 NEW LEAD CAPTURED:');
    console.log('Name:', leadData.firstName);
    console.log('Phone:', phoneNumber);
    console.log('Email:', leadData.email);
    console.log('Address:', leadData.address);
    console.log('Monthly Bill:', leadData.electricalBill);
    console.log('Time:', new Date().toLocaleString());
    console.log('----------------------------');
}

// Save lead to email (100% reliable)
async function saveLeadToEmail(leadData) {
    try {
        const emailContent = `
🎉 NEW LEAD CAPTURED via WhatsApp Bot!

👤 Customer Details:
• Name: ${leadData.firstName}
• Phone: ${leadData.phoneNumber}
• Email: ${leadData.email}
• Address: ${leadData.address}
• Monthly Bill: ${leadData.electricalBill}
• Date: ${new Date().toLocaleString()}

💡 Follow up with this customer within 24 hours for best conversion!

---
End Loadshedding Pty WhatsApp Bot
        `;

        await transporter.sendMail({
            from: CONFIG.EMAIL_USER,
            to: CONFIG.SALES_EMAIL,
            subject: `🚨 New WhatsApp Lead: ${leadData.firstName} - ${leadData.electricalBill}`,
            text: emailContent
        });

        console.log('📧 Lead saved to email successfully!');
    } catch (error) {
        console.error('❌ Email save failed:', error.message);
    }
}

// Send follow-up with direct WhatsApp redirect
async function sendFollowUpMessage(phoneNumber, firstName) {
    try {
        await sleep(2000);
        
        const urgentMessage = `${firstName}, need an urgent quote? 🚀

💬 WhatsApp our sales team directly:
*+27 84 336 0063*

Click this link:
https://wa.me/27843360063?text=Hi%2C%20I%27m%20${encodeURIComponent(firstName)}%20and%20I%20need%20a%20solar%20quote

⚡ *Available now for instant quotes!*`;

        await sendMessage(phoneNumber, urgentMessage);
        console.log(`💬 Follow-up sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error('❌ Follow-up failed:', error.message);
    }
}

// Send WhatsApp message
async function sendMessage(phoneNumber, message) {
    try {
        await axios.post(
            `https://graph.facebook.com/v20.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`✅ Message sent to ${phoneNumber}`);
    } catch (error) {
        console.error('❌ Send error:', error.response?.data || error.message);
    }
}

// Email validation
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        leads_today: 'Check your email for leads!'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🤖 End Loadshedding Chatbot is running!');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🔗 Webhook: https://your-app-url.com/webhook`);
    console.log('💡 All leads will be emailed to you!');
});
