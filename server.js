const express = require('express');
const axios = require('axios');
const app = express();

// User sessions storage
const userSessions = new Map();

// Configuration - Updated with your details
const CONFIG = {
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
    WHATSAPP_PHONE_ID: '768489836345252',
    WEBHOOK_VERIFY_TOKEN: 'EndLoadshedding2024',
    SALES_EMAIL: 'sales@endloadshedding.com',
    
    // Zoho CRM Configuration
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_ACCESS_TOKEN: '', // Will be refreshed automatically
    ZOHO_API_DOMAIN: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
};

app.use(express.json());

// Refresh Zoho token on startup
refreshZohoToken();

// Refresh Zoho Access Token
async function refreshZohoToken() {
    try {
        const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
            params: {
                refresh_token: CONFIG.ZOHO_REFRESH_TOKEN,
                client_id: CONFIG.ZOHO_CLIENT_ID,
                client_secret: CONFIG.ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        
        CONFIG.ZOHO_ACCESS_TOKEN = response.data.access_token;
        console.log('✅ Zoho token refreshed successfully');
    } catch (error) {
        console.error('❌ Error refreshing Zoho token:', error.response?.data || error.message);
    }
}

// Create Lead in Zoho CRM
async function createZohoLead(leadData) {
    try {
        const leadPayload = {
            data: [{
                "First_Name": leadData.firstName,
                "Email": leadData.email,
                "Phone": leadData.phoneNumber,
                "Street": leadData.address,
                "Lead_Source": "WhatsApp Chatbot",
                "Company": "End Loadshedding Pty",
                "Description": `Monthly Electricity Bill: ${leadData.electricalBill}\nLead captured via WhatsApp Bot on ${new Date().toLocaleString()}`,
                "Lead_Status": "New Lead"
            }]
        };

        const response = await axios.post(
            `${CONFIG.ZOHO_API_DOMAIN}/crm/v2/Leads`,
            leadPayload,
            {
                headers: {
                    'Authorization': `Zoho-oauthtoken ${CONFIG.ZOHO_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.data && response.data.data[0].status === 'success') {
            const leadId = response.data.data[0].details.id;
            console.log(`✅ Lead created in Zoho CRM with ID: ${leadId}`);
            
            // Add a note about the monthly bill
            await addNoteToZohoLead(leadId, `Customer's monthly electricity bill: ${leadData.electricalBill}\nInterested in solar installation at: ${leadData.address}`);
            
            return leadId;
        } else {
            throw new Error('Failed to create lead');
        }
    } catch (error) {
        console.error('❌ Error creating Zoho lead:', error.response?.data || error.message);
        
        // If token expired, try refreshing and retry once
        if (error.response?.status === 401) {
            console.log('🔄 Token expired, refreshing...');
            await refreshZohoToken();
            return createZohoLead(leadData); // Retry once
        }
        
        throw error;
    }
}

// Add Note to Zoho Lead
async function addNoteToZohoLead(leadId, noteContent) {
    try {
        const notePayload = {
            data: [{
                "Note_Title": "WhatsApp Bot Interaction",
                "Note_Content": noteContent,
                "Parent_Id": leadId,
                "se_module": "Leads"
            }]
        };

        await axios.post(
            `${CONFIG.ZOHO_API_DOMAIN}/crm/v2/Notes`,
            notePayload,
            {
                headers: {
                    'Authorization': `Zoho-oauthtoken ${CONFIG.ZOHO_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Note added to Zoho lead');
    } catch (error) {
        console.error('❌ Error adding note to Zoho lead:', error.response?.data || error.message);
    }
}

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
    
    // Check if it's a button response
    const isButtonResponse = message.interactive?.button_reply?.id;
    
    let session = userSessions.get(phoneNumber) || {
        step: 'welcome',
        data: {}
    };

    console.log(`📱 Message from ${phoneNumber}: ${messageText || 'Button clicked: ' + isButtonResponse}`);

    // Handle button responses
    if (isButtonResponse === 'call_main_number') {
        await sendMessage(phoneNumber, `📞 *Ready to call for a quick quote?*\n\nDial: *+27 84 336 0063*\n\nOur team is standing by to help you with instant quotes and technical questions! 🌞⚡`);
        return;
    }

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
            // Validate address (must be more than 10 characters and contain typical address words)
            if (messageText.length < 10) {
                await sendMessage(phoneNumber, "Please provide a complete physical address including street name, suburb, and city (example: 123 Main Street, Greenpoint, Cape Town):");
                break;
            }
            
            // Check if address contains at least some meaningful content
            const addressWords = messageText.toLowerCase().split(' ');
            const hasStreetIndicators = addressWords.some(word => 
                ['street', 'road', 'avenue', 'drive', 'lane', 'way', 'close', 'crescent', 'place', 'st', 'rd', 'ave'].includes(word) ||
                /\d/.test(messageText) // Contains numbers
            );
            
            if (!hasStreetIndicators) {
                await sendMessage(phoneNumber, "Please provide a complete street address with numbers and street name (example: 45 Oak Street, Stellenbosch, Western Cape):");
                break;
            }
            
            session.data.address = messageText;
            await sendMessage(phoneNumber, "Great! 📍\n\nWhat's your average monthly electricity bill amount? Please provide the amount in Rands (example: R2500, R1800, R3200):");
            session.step = 'electricalBill';
            break;

        case 'electricalBill':
            // Validate electricity bill - must contain numbers and preferably R symbol
            const cleanBill = messageText.replace(/\s+/g, '').toLowerCase();
            
            // Check for common non-answers
            const invalidResponses = ['idonotknow', 'idontknow', 'dontknow', 'notknown', 'unknown', 'unsure', 'notsure', 'maybe', 'approximately', 'around', 'about'];
            const isInvalidResponse = invalidResponses.some(invalid => cleanBill.includes(invalid.replace(/\s+/g, '')));
            
            if (isInvalidResponse) {
                await sendMessage(phoneNumber, "To provide you with an accurate solar quote, we need your actual monthly electricity bill amount. Please check your latest electricity bill and provide the total amount (example: R2500, R1800, R3200):");
                break;
            }
            
            // Extract numbers from the message
            const numberMatch = messageText.match(/\d+/);
            if (!numberMatch) {
                await sendMessage(phoneNumber, "Please provide your monthly electricity bill as a number amount in Rands (example: R2500, R1800, R3200):");
                break;
            }
            
            const billAmount = parseInt(numberMatch[0]);
            
            // Validate reasonable bill amount (between R200 and R50000)
            if (billAmount < 200) {
                await sendMessage(phoneNumber, "That amount seems quite low for a monthly electricity bill. Please provide your total monthly electricity bill amount in Rands (example: R2500, R1800, R3200):");
                break;
            }
            
            if (billAmount > 50000) {
                await sendMessage(phoneNumber, "That amount seems very high. Please double-check and provide your monthly electricity bill amount in Rands (example: R2500, R1800, R3200):");
                break;
            }
            
            // Format the bill amount properly
            session.data.electricalBill = `R${billAmount}`;
            session.data.phoneNumber = phoneNumber;
            await completeLeadCapture(phoneNumber, session.data);
            session.step = 'completed';
            break;

        case 'completed':
            await sendMessage(phoneNumber, "Thank you! A sales specialist will contact you soon. 😊");
            break;
            
        case 'button_response':
            // Handle button clicks
            if (message.interactive?.button_reply?.id === 'call_main_number') {
                await sendMessage(phoneNumber, `📞 *Ready to call?*\n\nDial: *+27 84 336 0063*\n\nOur team is standing by to help you! 🌞⚡`);
            }
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
    
    // Log lead locally
    console.log('🎉 NEW LEAD CAPTURED:');
    console.log('Name:', leadData.firstName);
    console.log('Phone:', phoneNumber);
    console.log('Email:', leadData.email);
    console.log('Address:', leadData.address);
    console.log('Monthly Bill:', leadData.electricalBill);
    console.log('Time:', new Date().toLocaleString());
    
    // Create lead in Zoho CRM
    try {
        const zohoLeadId = await createZohoLead(leadData);
        console.log(`🎯 Lead synced to Zoho CRM: ${zohoLeadId}`);
        
    } catch (error) {
        console.error('❌ Failed to create Zoho lead:', error.message);
        // Lead is still captured locally, but failed to sync to CRM
    }
    
    // Schedule follow-up message with call button (1 minute delay)
    setTimeout(async () => {
        await sendQuickQuoteMessage(phoneNumber, leadData.firstName);
    }, 60000); // 60 seconds delay
    
    console.log('----------------------------');
}

// Send Quick Quote Message with WhatsApp Button
async function sendQuickQuoteMessage(phoneNumber, firstName) {
    try {
        // Send typing indicator first
        await sendTypingIndicator(phoneNumber);
        
        // Wait 2 seconds to simulate typing
        await sleep(2000);
        
        const quickQuoteMessage = {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'interactive',
            interactive: {
                type: 'button',
                header: {
                    type: 'text',
                    text: `${firstName}, need an urgent quote? 🚀`
                },
                body: {
                    text: `For immediate assistance or quick quotes, our sales team is standing by on WhatsApp.`
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: 'whatsapp_sales_team',
                                title: 'WhatsApp Sales Team 💬'
                            }
                        }
                    ]
                }
            }
        };

        await axios.post(
            `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
            quickQuoteMessage,
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`💬 Sales team WhatsApp message sent to ${phoneNumber}`);
        
        // Send follow-up with actual WhatsApp number link after delay
        setTimeout(async () => {
            await sendWhatsAppNumberLink(phoneNumber, firstName);
        }, 5000); // 5 seconds after the button message
        
    } catch (error) {
        console.error('❌ Error sending sales team message:', error.response?.data || error.message);
        
        // Fallback: send simple text message with WhatsApp number
        await sendSimpleWhatsAppMessage(phoneNumber, firstName);
    }
}

// Send WhatsApp Number Link
async function sendWhatsAppNumberLink(phoneNumber, firstName) {
    try {
        // Send typing indicator
        await sendTypingIndicator(phoneNumber);
        
        // Wait 2 seconds to simulate typing
        await sleep(2000);
        
        const whatsappMessage = `💬 WhatsApp: *+27 84 336 0063*

https://wa.me/27843360063?text=Hi%2C%20I%27m%20${encodeURIComponent(firstName)}%20and%20I%20need%20a%20solar%20quote`;

        await sendMessage(phoneNumber, whatsappMessage);
        console.log(`📱 WhatsApp contact details sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error('❌ Error sending WhatsApp link:', error.message);
    }
}

// Fallback Simple WhatsApp Message
async function sendSimpleWhatsAppMessage(phoneNumber, firstName) {
    try {
        // Send typing indicator
        await sendTypingIndicator(phoneNumber);
        await sleep(1000);
        
        const simpleMessage = `${firstName}, need an urgent quote?

💬 WhatsApp our sales team: *+27 84 336 0063*

https://wa.me/27843360063?text=Hi%2C%20I%27m%20${encodeURIComponent(firstName)}%20and%20I%20need%20a%20solar%20quote`;

        await sendMessage(phoneNumber, simpleMessage);
        console.log(`📱 Simple WhatsApp message sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error('❌ Error sending simple WhatsApp message:', error.message);
    }
}

// Send Typing Indicator
async function sendTypingIndicator(phoneNumber) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: phoneNumber,
                type: 'reaction',
                reaction: {
                    message_id: '', // Empty for typing indicator
                    emoji: '⌨️'
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        // Typing indicator is optional, don't log errors
    }
}

// Sleep function for delays
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Send WhatsApp message with typing simulation
async function sendMessage(phoneNumber, message) {
    try {
        // Send typing indicator first
        await sendTypingIndicator(phoneNumber);
        
        // Calculate realistic typing delay (approximately 50ms per character)
        const typingDelay = Math.min(Math.max(message.length * 50, 1000), 4000); // Between 1-4 seconds
        await sleep(typingDelay);
        
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        zoho_token_active: !!CONFIG.ZOHO_ACCESS_TOKEN,
        timestamp: new Date().toISOString()
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🤖 End Loadshedding Chatbot is running!');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🔗 Webhook: https://your-app-url.com/webhook`);
    console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
    console.log('💡 Waiting for messages...');
});
