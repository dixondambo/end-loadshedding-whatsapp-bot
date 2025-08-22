const express = require('express');
const axios = require('axios');
const app = express();

// Only load optional dependencies if available
let nodemailer, rateLimit, helmet;
let emailEnabled = false;

try {
    nodemailer = require('nodemailer');
    emailEnabled = true;
    console.log('✅ Nodemailer loaded successfully');
} catch (error) {
    console.log('⚠️ Nodemailer not available, email features disabled');
}

try {
    rateLimit = require('express-rate-limit');
    helmet = require('helmet');
    
    // Apply security middleware only if available
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100 // limit each IP to 100 requests per windowMs
    });
    app.use(limiter);
    app.use(helmet());
    console.log('✅ Security middleware loaded');
} catch (error) {
    console.log('⚠️ Security middleware not available, using basic setup');
}

app.use(express.json({ limit: '10mb' }));

// User sessions storage with cleanup and follow-up tracking
const userSessions = new Map();
const followUpTimers = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const FOLLOW_UP_DELAY = 10 * 60 * 1000; // 10 minutes
const MESSAGE_STATUS_CHECK_DELAY = 2 * 60 * 1000; // 2 minutes to check delivery status

// Clean up old sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT) {
            userSessions.delete(key);
            // Clear any pending follow-up timers
            if (followUpTimers.has(key)) {
                clearTimeout(followUpTimers.get(key));
                followUpTimers.delete(key);
            }
        }
    }
}, 60 * 60 * 1000);

// Configuration with better environment handling
const CONFIG = {
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
    WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || '768489836345252',
    WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || 'EndLoadshedding2024',
    SALES_EMAIL: process.env.SALES_EMAIL || 'endloadshedding@gmail.com',
    
    // Updated email configuration
    EMAIL_USER: process.env.EMAIL_USER || 'endloadshedding@gmail.com',
    EMAIL_PASS: process.env.EMAIL_PASS || '@20endloadshedding',
    
    // Business settings
    SALES_PHONE: '+27843360063',
    COMPANY_NAME: 'End Loadshedding Pty Ltd',
    BUSINESS_EMAIL: 'sales@endloadshedding.com',
    BUSINESS_ADDRESS: 'Shop 4, 135 Main Rd, Somerset West, Cape Town, 7130',
    BUSINESS_WEBSITE: 'www.endloads.co.za',
    RESPONSE_DELAY: 2000,
    MIN_BILL_AMOUNT: 200,
    MAX_BILL_AMOUNT: 100000
};

// Validate required environment variables
const requiredEnvVars = ['WHATSAPP_TOKEN'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.warn(`⚠️  Warning: ${envVar} not set in environment variables`);
    }
}

// Email transporter setup (only if nodemailer is available)
let transporter;
if (emailEnabled && nodemailer) {
    try {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: CONFIG.EMAIL_USER,
                pass: CONFIG.EMAIL_PASS
            },
            pool: true,
            maxConnections: 5,
            maxMessages: 100
        });

        // Verify email configuration on startup
        transporter.verify((error, success) => {
            if (error) {
                console.error('❌ Email configuration error:', error.message);
                emailEnabled = false;
            } else {
                console.log('✅ Email server is ready');
            }
        });
    } catch (error) {
        console.error('❌ Failed to create email transporter:', error.message);
        emailEnabled = false;
    }
}

// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔍 Webhook verification attempt:', { mode, token: token ? 'provided' : 'missing' });

    if (mode === 'subscribe' && token === CONFIG.WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.status(403).send('Forbidden');
    }
});

// Enhanced message receiver with better error handling
app.post('/webhook', async (req, res) => {
    try {
        console.log('📨 Webhook received:', JSON.stringify(req.body, null, 2));
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            const promises = [];
            
            body.entry.forEach((entry) => {
                entry.changes.forEach((change) => {
                    if (change.field === 'messages') {
                        // Handle incoming messages
                        if (change.value.messages) {
                            change.value.messages.forEach((message) => {
                                promises.push(handleMessage(message));
                            });
                        }
                        // Handle message status updates (delivery, read receipts)
                        if (change.value.statuses) {
                            change.value.statuses.forEach((status) => {
                                promises.push(handleMessageStatus(status));
                            });
                        }
                    }
                });
            });

            // Handle all messages concurrently
            await Promise.allSettled(promises);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error');
    }
});

// Handle message status updates (delivery, read receipts)
async function handleMessageStatus(status) {
    try {
        const phoneNumber = status.recipient_id;
        const messageId = status.id;
        const statusType = status.status; // sent, delivered, read, failed
        
        console.log(`📊 Message status update: ${messageId} -> ${statusType} for ${phoneNumber}`);
        
        const session = userSessions.get(phoneNumber);
        if (session && session.followUps.pendingMessages.has(messageId)) {
            session.followUps.pendingMessages.set(messageId, {
                ...session.followUps.pendingMessages.get(messageId),
                status: statusType,
                statusTime: Date.now()
            });
            
            // If message is delivered (two ticks), schedule follow-up check
            if (statusType === 'delivered' || statusType === 'read') {
                scheduleFollowUp(phoneNumber, session);
            }
        }
    } catch (error) {
        console.error('❌ Message status handling error:', error);
    }
}

// Schedule follow-up for inactive users
function scheduleFollowUp(phoneNumber, session) {
    // Don't schedule if user already completed the flow or is dead lead
    if (session.step === 'completed' || session.followUps.count >= 3) {
        return;
    }
    
    // Clear any existing timer
    if (followUpTimers.has(phoneNumber)) {
        clearTimeout(followUpTimers.get(phoneNumber));
    }
    
    const timer = setTimeout(async () => {
        await sendFollowUpSequence(phoneNumber, session);
    }, FOLLOW_UP_DELAY);
    
    followUpTimers.set(phoneNumber, timer);
    console.log(`⏰ Follow-up scheduled for ${phoneNumber} in ${FOLLOW_UP_DELAY / 60000} minutes`);
}

// Send follow-up message sequence
async function sendFollowUpSequence(phoneNumber, session) {
    try {
        // Check if user has responded since we scheduled this follow-up
        const now = Date.now();
        if (now - session.lastActivity < FOLLOW_UP_DELAY) {
            console.log(`⏭️ User ${phoneNumber} has responded recently, skipping follow-up`);
            return;
        }
        
        // Check if it's been more than 24 hours since first follow-up
        if (session.followUps.lastFollowUp && 
            now - session.followUps.lastFollowUp > 24 * 60 * 60 * 1000) {
            console.log(`💀 Marking ${phoneNumber} as dead lead (24h+ inactive)`);
            session.step = 'dead_lead';
            return;
        }
        
        session.followUps.count++;
        session.followUps.lastFollowUp = now;
        
        let followUpMessage = '';
        
        switch (session.followUps.count) {
            case 1:
                followUpMessage = getFollowUpMessage1(session);
                break;
            case 2:
                followUpMessage = getFollowUpMessage2(session);
                break;
            case 3:
                followUpMessage = getFollowUpMessage3(session);
                break;
            default:
                // After 3 follow-ups, mark as dead lead
                console.log(`💀 Marking ${phoneNumber} as dead lead after 3 follow-ups`);
                session.step = 'dead_lead';
                return;
        }
        
        console.log(`📤 Sending follow-up ${session.followUps.count} to ${phoneNumber}`);
        await sendMessageWithTracking(phoneNumber, followUpMessage, session);
        
        // Update session
        userSessions.set(phoneNumber, session);
        
    } catch (error) {
        console.error('❌ Follow-up sequence error:', error);
    }
}

// Follow-up message templates
function getFollowUpMessage1(session) {
    const stepMessages = {
        'email': "Still waiting on the request above.",
        'firstName': "Still waiting on the request above.",
        'address': "Still waiting on the request above.",
        'electricalBill': "Still waiting on the request above."
    };
    
    return stepMessages[session.step] || "Still waiting on the request above.";
}

function getFollowUpMessage2(session) {
    return "Hi are you still there?";
}

function getFollowUpMessage3(session) {
    return "I'm still here to help you get started with solar. ☀️";
}
async function handleMessage(message) {
    try {
        const phoneNumber = message.from;
        const messageText = message.text?.body?.trim() || '';
        
        console.log(`📱 Processing message from ${phoneNumber}: "${messageText}"`);
        
        // Skip empty messages or system messages
        if (!messageText || message.type !== 'text') {
            console.log('⏭️ Skipping non-text or empty message');
            return;
        }

        let session = userSessions.get(phoneNumber) || {
            step: 'welcome',
            data: {},
            lastActivity: Date.now(),
            attempts: {},
            followUps: {
                count: 0,
                lastFollowUp: null,
                pendingMessages: new Map() // messageId -> {timestamp, status}
            },
            quotationFollowUp: {
                scheduled: false,
                completed: false,
                responseReceived: false
            }
        };

        // Update last activity and clear any pending follow-ups
        session.lastActivity = Date.now();
        
        // Clear follow-up timer since user responded
        if (followUpTimers.has(phoneNumber)) {
            clearTimeout(followUpTimers.get(phoneNumber));
            followUpTimers.delete(phoneNumber);
        }

        console.log(`👤 Current session step: ${session.step}`);

        // Handle business information requests
        if (lowerText.includes('email') && (lowerText.includes('your') || lowerText.includes('business') || lowerText.includes('contact'))) {
            await sendMessage(phoneNumber, `Our business email is: ${CONFIG.BUSINESS_EMAIL}`);
            userSessions.set(phoneNumber, session);
            return;
        }
        
        if (lowerText.includes('address') && (lowerText.includes('your') || lowerText.includes('business') || lowerText.includes('physical') || lowerText.includes('office'))) {
            await sendMessage(phoneNumber, `Our address is: ${CONFIG.BUSINESS_ADDRESS}`);
            userSessions.set(phoneNumber, session);
            return;
        }
        
        if (lowerText.includes('website') || lowerText.includes('web site') || lowerText.includes('site')) {
            await sendMessage(phoneNumber, `Our website is: ${CONFIG.BUSINESS_WEBSITE}`);
            userSessions.set(phoneNumber, session);
            return;
        }
        
        // Handle installation area questions
        if ((lowerText.includes('install') || lowerText.includes('service')) && 
            (lowerText.includes('area') || lowerText.includes('city') || lowerText.includes('town') || 
             lowerText.includes('region') || lowerText.includes('province') || lowerText.includes('where') ||
             lowerText.includes('durban') || lowerText.includes('joburg') || lowerText.includes('johannesburg') || 
             lowerText.includes('pretoria') || lowerText.includes('cape town') || lowerText.includes('bloemfontein') ||
             lowerText.includes('port elizabeth') || lowerText.includes('nelspruit') || lowerText.includes('polokwane'))) {
            await sendMessage(phoneNumber, `Yes! We install anywhere in South Africa 🇿🇦 The installation and travel costs are included in your quote. Contact ${CONFIG.SALES_PHONE} for your personalized quote.`);
            userSessions.set(phoneNumber, session);
            return;
        }
        
        // Handle quotation follow-up responses
        if (session.quotationFollowUp.scheduled && !session.quotationFollowUp.responseReceived) {
            if (lowerText.includes('yes') || lowerText.includes('received') || lowerText.includes('got')) {
                session.quotationFollowUp.responseReceived = true;
                session.quotationFollowUp.completed = true;
                await sendMessage(phoneNumber, `Great! 🎉 Before making your decision, feel free to check out our customer reviews at https://www.hellopeter.com/endloadsheddingcom to see what others say about our solar installations.`);
                userSessions.set(phoneNumber, session);
                return;
            } else if (lowerText.includes('no') || lowerText.includes('not') || lowerText.includes('haven')) {
                await sendMessage(phoneNumber, `No problem! Please contact ${CONFIG.SALES_PHONE} directly and they'll ensure you receive your quotation promptly. Sometimes quotes may go to spam folders, so please check there too.`);
                userSessions.set(phoneNumber, session);
                return;
            }
        }
        if (lowerText.includes('restart') || lowerText.includes('start over')) {
            session.step = 'welcome';
            session.data = {};
            session.attempts = {};
            console.log('🔄 Session restarted');
        } else if (lowerText.includes('help')) {
            await sendHelpMessage(phoneNumber);
            userSessions.set(phoneNumber, session);
            return;
        }

        // Add realistic delay
        await sleep(CONFIG.RESPONSE_DELAY);

        await processStep(phoneNumber, messageText, session);
        userSessions.set(phoneNumber, session);

    } catch (error) {
        console.error('❌ Message handling error:', error);
        await sendMessage(phoneNumber, "Sorry, something went wrong. Please type 'restart' to begin again.");
    }
}

// Process conversation steps
async function processStep(phoneNumber, messageText, session) {
    console.log(`🔄 Processing step: ${session.step}`);
    
    switch (session.step) {
        case 'welcome':
            await sendWelcomeMessage(phoneNumber);
            session.step = 'email';
            break;

        case 'email':
            await handleEmailStep(phoneNumber, messageText, session);
            break;

        case 'firstName':
            await handleFirstNameStep(phoneNumber, messageText, session);
            break;

        case 'address':
            await handleAddressStep(phoneNumber, messageText, session);
            break;

        case 'electricalBill':
            await handleElectricalBillStep(phoneNumber, messageText, session);
            break;

        case 'completed':
            await sendMessage(phoneNumber, `WhatsApp your details to ${CONFIG.SALES_PHONE} ASAP....he will advise and send you a quote.`);
            break;

        case 'dead_lead':
            // Don't respond to dead leads
            console.log(`💀 Ignoring message from dead lead: ${phoneNumber}`);
            break;

        default:
            console.log(`⚠️ Unknown step: ${session.step}, resetting to welcome`);
            await sendWelcomeMessage(phoneNumber);
            session.step = 'email';
    }
}

// Welcome message
async function sendWelcomeMessage(phoneNumber) {
    const welcomeMsg = `🔋 *Welcome to End Loadshedding Pty Chatbot!*

Before I connect you to a Customer Support Specialist.

Could you please share your best email address? 📧`;
    
    await sendMessage(phoneNumber, welcomeMsg);
}

// Handle email step with validation
async function handleEmailStep(phoneNumber, messageText, session) {
    if (isValidEmail(messageText)) {
        session.data.email = messageText.toLowerCase();
        await sendMessage(phoneNumber, "Perfect! ✅\n\nWhat's your first name?");
        session.step = 'firstName';
        session.attempts.email = 0;
    } else {
        session.attempts.email = (session.attempts.email || 0) + 1;
        
        if (session.attempts.email >= 3) {
            await sendMessage(phoneNumber, "Having trouble with your email? Type 'help' for assistance or contact us directly at " + CONFIG.SALES_PHONE);
            return;
        }
        
        await sendMessage(phoneNumber, "Please provide a valid email address:\n\n📧 Example: john@gmail.com\n\n_Make sure it includes @ and a domain like .com_");
    }
}

// Handle first name step
async function handleFirstNameStep(phoneNumber, messageText, session) {
    if (messageText.length < 2 || messageText.length > 50) {
        await sendMessage(phoneNumber, "Please provide your first name (2-50 characters):");
        return;
    }
    
    // Clean the name
    const firstName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
    if (firstName.length < 2) {
        await sendMessage(phoneNumber, "Please provide a valid first name using letters only:");
        return;
    }
    
    session.data.firstName = firstName;
    await sendMessage(phoneNumber, `Nice to meet you, ${firstName}! 👋\n\nWhat's the physical address where you'd like to install solar?\n\n📍 Please include street, suburb, and city`);
    session.step = 'address';
}

// Handle address step
async function handleAddressStep(phoneNumber, messageText, session) {
    if (messageText.length < 15) {
        session.attempts.address = (session.attempts.address || 0) + 1;
        
        if (session.attempts.address >= 3) {
            await sendMessage(phoneNumber, "Need help with your address? Contact us directly at " + CONFIG.SALES_PHONE);
            return;
        }
        
        await sendMessage(phoneNumber, "Please provide a complete address:\n\n📍 Example: 123 Main Street, Sandton, Johannesburg\n\n_Include street name, suburb, and city_");
        return;
    }
    
    session.data.address = messageText.trim();
    await sendMessage(phoneNumber, `Great! 📍\n\nWhat's your average monthly electricity bill?\n\n💡 Example: R2500, R1800, R3200\n\n_This helps us size your system correctly_`);
    session.step = 'electricalBill';
}

// Handle electrical bill step with enhanced validation
async function handleElectricalBillStep(phoneNumber, messageText, session) {
    const cleanBill = messageText.replace(/\s+/g, '').toLowerCase();
    const invalidResponses = ['idonotknow', 'idontknow', 'dontknow', 'unknown', 'unsure', 'donno', 'dk'];
    const isInvalidResponse = invalidResponses.some(invalid => cleanBill.includes(invalid));
    
    if (isInvalidResponse) {
        await sendMessage(phoneNumber, "No worries! Please check your latest Eskom/City Power bill and share the total amount:\n\n💡 Example: R2500, R1800, R3200");
        return;
    }
    
    // Enhanced number extraction - fix for large numbers
    const numberMatch = messageText.match(/(?:r\s*)?(\d{1,6}(?:[,\s]\d{3})*(?:\.\d{2})?)/i);
    if (!numberMatch) {
        session.attempts.bill = (session.attempts.bill || 0) + 1;
        
        if (session.attempts.bill >= 3) {
            await sendMessage(phoneNumber, "Having trouble? Contact us directly for assistance: " + CONFIG.SALES_PHONE);
            return;
        }
        
        await sendMessage(phoneNumber, "Please provide your bill amount as a number:\n\n💡 Example: 2500, R1800, or 3200\n\n_Just the rand amount from your electricity bill_");
        return;
    }
    
    // Fix: Handle large numbers properly - don't remove commas/spaces until after extraction
    let billAmount = parseInt(numberMatch[1].replace(/[,\s]/g, ''));
    
    // Handle case where user types something like "22500" but we extracted "225"
    const originalNumber = messageText.match(/\d+/g)?.join('') || '';
    if (originalNumber.length >= 3) {
        billAmount = parseInt(originalNumber);
    }
    
    if (billAmount < CONFIG.MIN_BILL_AMOUNT || billAmount > CONFIG.MAX_BILL_AMOUNT) {
        await sendMessage(phoneNumber, `Please double-check your monthly bill amount:\n\n• Should be between R${CONFIG.MIN_BILL_AMOUNT} - R${CONFIG.MAX_BILL_AMOUNT}\n• Check your latest bill for the exact amount`);
        return;
    }
    
    session.data.electricalBill = `R${billAmount.toLocaleString()}`;
    session.data.phoneNumber = phoneNumber;
    session.data.timestamp = new Date().toISOString();
    
    await completeLeadCapture(phoneNumber, session.data);
    session.step = 'completed';
}

// Enhanced lead completion
async function completeLeadCapture(phoneNumber, leadData) {
    const summaryMessage = `✅ *Perfect! Thank you ${leadData.firstName}!*

📋 *Your Information:*
📧 Email: ${leadData.email}
📍 Address: ${leadData.address}
💡 Monthly Bill: ${leadData.electricalBill}

🎯 *Our specialist will contact you within 24 hours!*

🌞 Get ready to save money and beat loadshedding!`;

    await sendMessage(phoneNumber, summaryMessage);
    
    // Save lead (with retry logic) - only if email is enabled
    if (emailEnabled) {
        await saveLeadWithRetry(leadData);
    } else {
        // Log to console as fallback
        console.log('📧 Email not available, logging lead data:');
        console.log(JSON.stringify(leadData, null, 2));
    }
    
    // Send follow-up after 2 minutes
    setTimeout(async () => {
        await sendFollowUpMessage(phoneNumber, leadData.firstName);
    }, 120000);
    
    // Schedule 24-hour quotation follow-up
    setTimeout(async () => {
        await sendQuotationFollowUp(phoneNumber, leadData.firstName);
    }, 24 * 60 * 60 * 1000); // 24 hours
    
    // Enhanced logging
    console.log('🎉 NEW LEAD CAPTURED:');
    console.log({
        name: leadData.firstName,
        phone: phoneNumber,
        email: leadData.email,
        address: leadData.address,
        monthlyBill: leadData.electricalBill,
        timestamp: leadData.timestamp
    });
    console.log('----------------------------');
}

// Enhanced email saving with retry logic
async function saveLeadWithRetry(leadData, retries = 3) {
    if (!emailEnabled || !transporter) {
        console.log('📧 Email not enabled, skipping email save');
        return;
    }

    for (let i = 0; i < retries; i++) {
        try {
            await saveLeadToEmail(leadData);
            console.log('📧 Lead saved to email successfully!');
            return;
        } catch (error) {
            console.error(`❌ Email save attempt ${i + 1} failed:`, error.message);
            if (i === retries - 1) {
                // Final attempt failed - log to console as backup
                console.error('🚨 CRITICAL: Email save failed completely. Lead data:');
                console.error(JSON.stringify(leadData, null, 2));
            } else {
                await sleep(2000); // Wait before retry
            }
        }
    }
}

// Enhanced email content
async function saveLeadToEmail(leadData) {
    if (!transporter) {
        throw new Error('Email transporter not available');
    }

    const emailContent = `
🎉 NEW SOLAR LEAD CAPTURED!

👤 Customer Details:
• Name: ${leadData.firstName}
• Phone: ${leadData.phoneNumber}
• Email: ${leadData.email}
• Address: ${leadData.address}
• Monthly Bill: ${leadData.electricalBill}
• Date: ${new Date(leadData.timestamp).toLocaleString('en-ZA')}

💡 Priority: Follow up within 24 hours for best conversion!
📞 Customer expects contact soon.

---
${CONFIG.COMPANY_NAME} WhatsApp Bot
Generated: ${new Date().toLocaleString('en-ZA')}
    `;

    await transporter.sendMail({
        from: `"${CONFIG.COMPANY_NAME} Bot" <${CONFIG.EMAIL_USER}>`,
        to: CONFIG.SALES_EMAIL,
        subject: `🚨 NEW SOLAR LEAD: ${leadData.firstName} - ${leadData.electricalBill} monthly bill`,
        text: emailContent
    });
}

// Send 24-hour quotation follow-up
async function sendQuotationFollowUp(phoneNumber, firstName) {
    try {
        const session = userSessions.get(phoneNumber);
        if (!session || session.quotationFollowUp.completed) {
            return; // Don't send if session expired or already completed
        }
        
        session.quotationFollowUp.scheduled = true;
        
        const quotationMessage = `Hi ${firstName}! 📋

It's been 24 hours since we captured your details. Have you received your solar quotation yet?

Please reply:
• "Yes" if you received it
• "No" if you haven't received it

We're here to help! 🌞`;

        await sendMessage(phoneNumber, quotationMessage);
        userSessions.set(phoneNumber, session);
        
        // Schedule follow-up if no response in 2 hours
        setTimeout(async () => {
            const updatedSession = userSessions.get(phoneNumber);
            if (updatedSession && updatedSession.quotationFollowUp.scheduled && 
                !updatedSession.quotationFollowUp.responseReceived) {
                
                const reminderMessage = `${firstName}, just checking if you received your solar quote? 

If you haven't, please contact ${CONFIG.SALES_PHONE} directly for immediate assistance.`;
                
                await sendMessage(phoneNumber, reminderMessage);
            }
        }, 2 * 60 * 60 * 1000); // 2 hours later
        
        console.log(`📋 24-hour quotation follow-up sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error('❌ Quotation follow-up failed:', error.message);
    }
}
async function sendFollowUpMessage(phoneNumber, firstName) {
    try {
        await sleep(CONFIG.RESPONSE_DELAY);
        
        const urgentMessage = `${firstName}, need an urgent quote? 🚀

WhatsApp your details to ${CONFIG.SALES_PHONE} ASAP....he will advise and send you a quote.`;

        await sendMessage(phoneNumber, urgentMessage);
        console.log(`💬 Follow-up sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error('❌ Follow-up failed:', error.message);
    }
}

// Help message
async function sendHelpMessage(phoneNumber) {
    const helpMsg = `🆘 *Need Help?*

*Commands:*
• Type 'restart' to start over
• Type 'help' for this message

*Business Information:*
• Email: ${CONFIG.BUSINESS_EMAIL}
• Address: ${CONFIG.BUSINESS_ADDRESS}
• Website: ${CONFIG.BUSINESS_WEBSITE}
• Phone: ${CONFIG.SALES_PHONE}

*Coverage:* We install anywhere in South Africa 🇿🇦

*What we need:*
1. Valid email address
2. Your first name  
3. Installation address
4. Monthly electricity bill amount`;
    
    await sendMessage(phoneNumber, helpMsg);
}

// Enhanced message sender with delivery tracking
async function sendMessage(phoneNumber, message, retries = 3) {
    const session = userSessions.get(phoneNumber);
    return await sendMessageWithTracking(phoneNumber, message, session, retries);
}

// Send message with delivery tracking
async function sendMessageWithTracking(phoneNumber, message, session, retries = 3) {
    console.log(`📤 Attempting to send message to ${phoneNumber}`);
    
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(
                `https://graph.facebook.com/v20.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    text: { body: message },
                    type: 'text'
                },
                {
                    headers: {
                        'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            
            const messageId = response.data?.messages?.[0]?.id;
            if (messageId && session) {
                // Track this message for delivery status
                session.followUps.pendingMessages.set(messageId, {
                    timestamp: Date.now(),
                    status: 'sent',
                    message: message.substring(0, 100) // Store first 100 chars for reference
                });
                
                // Schedule follow-up check after message status delay
                setTimeout(() => {
                    const msgStatus = session.followUps.pendingMessages.get(messageId);
                    if (msgStatus && (msgStatus.status === 'delivered' || msgStatus.status === 'read')) {
                        scheduleFollowUp(phoneNumber, session);
                    }
                }, MESSAGE_STATUS_CHECK_DELAY);
            }
            
            console.log(`✅ Message sent to ${phoneNumber}${messageId ? ` (ID: ${messageId})` : ''}`);
            return messageId;
        } catch (error) {
            console.error(`❌ Send attempt ${i + 1} failed:`, error.response?.data || error.message);
            if (i < retries - 1) {
                await sleep(1000); // Wait before retry
            }
        }
    }
    console.error(`🚨 Failed to send message to ${phoneNumber} after ${retries} attempts`);
    return null;
}

// Enhanced email validation
function isValidEmail(email) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email) && email.length <= 254;
}

// Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Enhanced health check
app.get('/health', (req, res) => {
    const stats = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: userSessions.size,
        environment: process.env.NODE_ENV || 'development',
        version: '2.1.0',
        features: {
            email: emailEnabled,
            whatsapp: !!CONFIG.WHATSAPP_TOKEN
        }
    };
    
    res.json(stats);
});

// Stats endpoint
app.get('/stats', (req, res) => {
    const activeFollowUps = Array.from(userSessions.values()).filter(session => 
        session.followUps.count > 0 && session.step !== 'completed' && session.step !== 'dead_lead'
    ).length;
    
    const deadLeads = Array.from(userSessions.values()).filter(session => 
        session.step === 'dead_lead'
    ).length;
    
    const completedLeads = Array.from(userSessions.values()).filter(session => 
        session.step === 'completed'
    ).length;
    
    res.json({
        activeSessions: userSessions.size,
        activeFollowUps: activeFollowUps,
        deadLeads: deadLeads,
        completedLeads: completedLeads,
        pendingFollowUpTimers: followUpTimers.size,
        totalMemoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        emailEnabled
    });
});

// Test endpoint for debugging
app.get('/test', (req, res) => {
    res.json({
        message: 'Bot is running!',
        config: {
            hasWhatsAppToken: !!CONFIG.WHATSAPP_TOKEN,
            whatsappPhoneId: CONFIG.WHATSAPP_PHONE_ID,
            webhookToken: !!CONFIG.WEBHOOK_VERIFY_TOKEN,
            emailEnabled,
            environment: process.env.NODE_ENV
        }
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 ${CONFIG.COMPANY_NAME} Chatbot v2.1 is running!`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🔗 Webhook: https://your-app-url.com/webhook`);
    console.log(`📧 Email enabled: ${emailEnabled}`);
    console.log(`📞 Sales WhatsApp: ${CONFIG.SALES_PHONE}`);
    console.log('💡 Ready to capture solar leads!');
    
    // Test basic functionality
    console.log('\n🧪 Running startup tests...');
    console.log(`✅ WhatsApp Token: ${CONFIG.WHATSAPP_TOKEN ? 'Set' : 'Missing'}`);
    console.log(`✅ Phone ID: ${CONFIG.WHATSAPP_PHONE_ID}`);
    console.log(`✅ Webhook Token: ${CONFIG.WEBHOOK_VERIFY_TOKEN ? 'Set' : 'Missing'}`);
    console.log(`✅ Email: ${emailEnabled ? 'Configured' : 'Disabled'}`);
});
