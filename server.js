const express = require('express');
const axios = require('axios');
const app = express();

// User sessions storage
const userSessions = new Map();

// Configuration - Updated with your details
const CONFIG = {
    WHATSAPP_TOKEN: 'EAAQTTOVSzc4BPMKMMjFqaR7MfF1QwIZCA7mKLYJUiRxFZCQJohkRGGwcZCT9VHdIMWM4e0gWCdqiiDcMKMtB0jo1pfgPZAc2B3du8Tt0CVYdivaiFbmbRI7MwBBiZCdhLZBoNv5ZBRRIqmP3piKP3df2LAMywA3ywqRiQF88Kkrmc5qVZCEre5IW35jCAy98sM1NM4eJlH4OmMKcJqk4NOTuhNuSPWJ1xq8eUZAh4VBZBXSakZD',
    WHATSAPP_PHONE_ID: '768489836345252',
    WEBHOOK_VERIFY_TOKEN: 'EndLoadshedding2024',
    SALES_EMAIL: 'sales@endloadshedding.com'
};

app.use(express.json());

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

    switch (session.step) {
        case 'welcome':
            await sendWelcomeMessage(phoneNumber);
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
            session.data.address = messageText;
            await sendMessage(phoneNumber, "Great! 📍\n\nWhat's your average monthly electricity bill amount? (example: R2500)");
            session.step = 'electricalBill';
            break;

        case 'electricalBill':
            session.data.electricalBill = messageText;
            await completeLeadCapture(phoneNumber, session.data);
            session.step = 'completed';
            break;

        case 'completed':
            await sendMessage(phoneNumber, "Thank you! A sales specialist will contact you soon. 😊");
            break;

        default:
            await sendWelcomeMessage(phoneNumber);
            session.step = 'email';
    }

    userSessions.set(phoneNumber, session);
}

// Welcome message
async function sendWelcomeMessage(phoneNumber) {
    const message = `🔋 *Hey there! Welcome to End Loadshedding Pty Chatbot!*

Before I connect you to a Customer Support Specialist, I need some quick info.

Could you please share your best email address? 📧`;

    await sendMessage(phoneNumber, message);
}

// Complete lead and notify
async function completeLeadCapture(phoneNumber, leadData) {
    const message = `✅ *Perfect! Thank you ${leadData.firstName}!*

📋 *Your Information:*
📧 Email: ${leadData.email}
📍 Address: ${leadData.address}
💡 Monthly Bill: ${leadData.electricalBill}

🎯 *Our sales specialist will contact you within 24 hours!*

Thank you for choosing End Loadshedding Pty! 🌞⚡`;

    await sendMessage(phoneNumber, message);
    
    // Log lead (you'll see this in your terminal)
    console.log('🎉 NEW LEAD CAPTURED:');
    console.log('Name:', leadData.firstName);
    console.log('Phone:', phoneNumber);
    console.log('Email:', leadData.email);
    console.log('Address:', leadData.address);
    console.log('Monthly Bill:', leadData.electricalBill);
    console.log('Time:', new Date().toLocaleString());
    console.log('----------------------------');
}

// Send WhatsApp message
async function sendMessage(phoneNumber, message) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🤖 End Loadshedding Chatbot is running!');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🔗 Webhook: https://your-app-url.com/webhook`);
    console.log('💡 Waiting for messages...');
});
