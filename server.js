require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const NodeCache = require('node-cache');
const { Configuration, OpenAIApi } = require('openai');

const app = express();

// ----------------------------
// Configuration
// ----------------------------
const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  SALES_EMAIL: process.env.SALES_EMAIL,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  NEWS_API_KEY: process.env.NEWS_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  SALES_PHONE: '+27843360063',
  COMPANY_NAME: 'End Loadshedding Pty Ltd',
  RESPONSE_DELAY: 2000,
  MIN_BILL_AMOUNT: 200,
  MAX_BILL_AMOUNT: 50000,
};

// Warn about missing required variables
['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WEBHOOK_VERIFY_TOKEN',
 'SALES_EMAIL', 'EMAIL_USER', 'EMAIL_PASS'].forEach((key) => {
  if (!CONFIG[key]) {
    console.warn(`⚠️  Warning: ${key} is not set in the environment.`);
  }
});

// ----------------------------
// Security and middleware
// ----------------------------
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// ----------------------------
// Session management
// ----------------------------
const userSessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, session] of userSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      userSessions.delete(key);
    }
  }
}, 60 * 60 * 1000);

// ----------------------------
// Email transport
// ----------------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: CONFIG.EMAIL_USER,
    pass: CONFIG.EMAIL_PASS,
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
});

transporter.verify((err) => {
  if (err) {
    console.error('❌ Email configuration error:', err.message);
  } else {
    console.log('✅ Email transporter is ready');
  }
});

// ----------------------------
// External API clients
// ----------------------------
const newsCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

async function fetchSolarNews() {
  const cached = newsCache.get('solarNews');
  if (cached) return cached;
  if (!CONFIG.NEWS_API_KEY) return null;
  const url =
    `https://newsapi.org/v2/everything?q=solar%20energy%20south%20africa&language=en&sortBy=publishedAt&pageSize=3&apiKey=${CONFIG.NEWS_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  if (!data.articles) return null;
  const articles = data.articles.map((a) => ({
    title: a.title,
    url: a.url,
    description: a.description || '',
  }));
  newsCache.set('solarNews', articles);
  return articles;
}

// OpenAI client
let openai;
if (CONFIG.OPENAI_API_KEY) {
  const configuration = new Configuration({ apiKey: CONFIG.OPENAI_API_KEY });
  openai = new OpenAIApi(configuration);
}

async function askChatGPT(prompt) {
  if (!openai) return null;
  const messages = [
    {
      role: 'system',
      content:
        'You are a helpful assistant specialised in South African solar energy. Answer concisely and in a friendly tone.',
    },
    { role: 'user', content: prompt },
  ];
  try {
    const { data } = await openai.createChatCompletion({
      model: 'gpt-4',
      messages,
      max_tokens: 200,
      temperature: 0.7,
    });
    return data.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    console.error('❌ OpenAI API error:', err.message);
    return null;
  }
}

// ----------------------------
// Webhook verification
// ----------------------------
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === CONFIG.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  console.log('❌ Webhook verification failed');
  res.status(403).send('Forbidden');
});

// ----------------------------
// Webhook receiver
// ----------------------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const tasks = [];
      body.entry.forEach((entry) => {
        entry.changes.forEach((change) => {
          if (change.field === 'messages' && change.value.messages) {
            change.value.messages.forEach((message) => {
              tasks.push(handleMessage(message));
            });
          }
        });
      });
      await Promise.allSettled(tasks);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
    res.status(500).send('Error');
  }
});

// ----------------------------
// Core message handler
// ----------------------------
async function handleMessage(message) {
  const phoneNumber = message.from;
  const messageText = message.text?.body?.trim() || '';
  if (!messageText || message.type !== 'text') return;

  let session = userSessions.get(phoneNumber) || {
    step: 'welcome',
    data: {},
    lastActivity: Date.now(),
    attempts: {},
  };
  session.lastActivity = Date.now();
  const lowerText = messageText.toLowerCase();

  // Commands that work anytime
  if (lowerText.includes('restart') || lowerText.includes('start over')) {
    session.step = 'welcome';
    session.data = {};
    session.attempts = {};
  } else if (lowerText === 'help') {
    await sendHelpMessage(phoneNumber);
    userSessions.set(phoneNumber, session);
    return;
  } else if (lowerText === 'news') {
    const articles = await fetchSolarNews();
    if (articles && articles.length) {
      const newsMsg = articles
        .map(
          (a, idx) =>
            `${idx + 1}. ${a.title}\n${a.description}\nRead more: ${a.url}`
        )
        .join('\n\n');
      await sendMessage(phoneNumber, `📰 *Latest Solar News*\n\n${newsMsg}`);
    } else {
      await sendMessage(
        phoneNumber,
        'Sorry, I could not fetch solar news right now. Please try again later.'
      );
    }
    userSessions.set(phoneNumber, session);
    return;
  } else if (
    lowerText.includes('solar') &&
    (lowerText.includes('how') || lowerText.includes('what') || lowerText.includes('why'))
  ) {
    const answer = await askChatGPT(messageText);
    if (answer) {
      await sendMessage(phoneNumber, answer);
    } else {
      await sendMessage(
        phoneNumber,
        "I'm sorry, I couldn't answer that right now. You can ask about solar installation steps, cost or benefits."
      );
    }
    userSessions.set(phoneNumber, session);
    return;
  }

  // Pause to simulate typing
  await sleep(CONFIG.RESPONSE_DELAY);
  await processStep(phoneNumber, messageText, session);
  userSessions.set(phoneNumber, session);
}

async function processStep(phoneNumber, messageText, session) {
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
      await sendMessage(
        phoneNumber,
        `Hi ${session.data.firstName}! A sales specialist will contact you soon. 😊\n\nFor urgent quotes, WhatsApp us: ${CONFIG.SALES_PHONE}`
      );
      break;
    default:
      await sendWelcomeMessage(phoneNumber);
      session.step = 'email';
  }
}

// ----------------------------
// Step handlers
// ----------------------------
async function sendWelcomeMessage(phoneNumber) {
  const msg = `🔋 *Welcome to ${CONFIG.COMPANY_NAME} Chatbot!*\n\nTransform your home with solar power and say goodbye to loadshedding! 🌞\n\nBefore connecting you to our specialists, I need some quick info.\n\nPlease share your best email address: 📧\n\nYou can also type 'news' for the latest solar headlines, or ask me any solar question.\n\n_Type 'help' for assistance or 'restart' to start over_`;
  await sendMessage(phoneNumber, msg);
}

async function handleEmailStep(phoneNumber, messageText, session) {
  if (isValidEmail(messageText)) {
    session.data.email = messageText.toLowerCase();
    await sendMessage(phoneNumber, 'Perfect! ✅\n\nWhat\'s your first name?');
    session.step = 'firstName';
    session.attempts.email = 0;
  } else {
    session.attempts.email = (session.attempts.email || 0) + 1;
    if (session.attempts.email >= 3) {
      await sendMessage(
        phoneNumber,
        `Having trouble with your email? Type 'help' or contact us at ${CONFIG.SALES_PHONE}`
      );
      return;
    }
    await sendMessage(
      phoneNumber,
      "Please provide a valid email address:\n\n📧 Example: john@gmail.com\n\nMake sure it includes @ and a domain like .com"
    );
  }
}

async function handleFirstNameStep(phoneNumber, messageText, session) {
  if (messageText.length < 2 || messageText.length > 50) {
    await sendMessage(phoneNumber, 'Please provide your first name (2–50 characters):');
    return;
  }
  const firstName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
  if (firstName.length < 2) {
    await sendMessage(phoneNumber, 'Please provide a valid first name using letters only:');
    return;
  }
  session.data.firstName = firstName;
  await sendMessage(
    phoneNumber,
    `Nice to meet you, ${firstName}! 👋\n\nWhat\'s the physical address where you'd like to install solar?\n\n📍 Please include street, suburb, and city.`
  );
  session.step = 'address';
}

async function handleAddressStep(phoneNumber, messageText, session) {
  if (messageText.length < 15) {
    session.attempts.address = (session.attempts.address || 0) + 1;
    if (session.attempts.address >= 3) {
      await sendMessage(
        phoneNumber,
        `Need help with your address? Contact us directly at ${CONFIG.SALES_PHONE}`
      );
      return;
    }
    await sendMessage(
      phoneNumber,
      "Please provide a complete address:\n\n📍 Example: 123 Main Street, Sandton, Johannesburg\n\nInclude street name, suburb and city."
    );
    return;
  }
  session.data.address = messageText.trim();
  await sendMessage(
    phoneNumber,
    `Great! 📍\n\nWhat's your average monthly electricity bill?\n\n💡 Example: R2500, R1800, R3200\n\nThis helps us size your system correctly.`
  );
  session.step = 'electricalBill';
}

async function handleElectricalBillStep(phoneNumber, messageText, session) {
  const clean = messageText.replace(/\s+/g, '').toLowerCase();
  const invalid = ['idonotknow', 'idontknow', 'dontknow', 'unknown', 'unsure', 'donno', 'dk'];
  if (invalid.some((w) => clean.includes(w))) {
    await sendMessage(
      phoneNumber,
      "No worries! Please check your latest Eskom/City Power bill and share the total amount."
    );
    return;
  }
  const match = messageText.match(/(?:r\s*)?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?)/i);
  if (!match) {
    session.attempts.bill = (session.attempts.bill || 0) + 1;
    if (session.attempts.bill >= 3) {
      await sendMessage(
        phoneNumber,
        `Having trouble? Contact us directly for assistance: ${CONFIG.SALES_PHONE}`
      );
      return;
    }
    await sendMessage(
      phoneNumber,
      "Please provide your bill amount as a number:\n\n💡 Example: 2500, R1800, or 3200\n\nJust the rand amount from your electricity bill."
    );
    return;
  }
  const bill = parseInt(match[1].replace(/[\s,]/g, ''), 10);
  if (bill < CONFIG.MIN_BILL_AMOUNT || bill > CONFIG.MAX_BILL_AMOUNT) {
    await sendMessage(
      phoneNumber,
      `Please double‑check your monthly bill amount:\n\n• Should be between R${CONFIG.MIN_BILL_AMOUNT} – R${CONFIG.MAX_BILL_AMOUNT}\n• Check your latest bill for the exact amount.`
    );
    return;
  }
  session.data.electricalBill = `R${bill.toLocaleString()}`;
  session.data.phoneNumber = phoneNumber;
  session.data.timestamp = new Date().toISOString();
  await completeLeadCapture(phoneNumber, session.data);
  session.step = 'completed';
}

// ----------------------------
// Lead completion
// ----------------------------
async function completeLeadCapture(phoneNumber, leadData) {
  const summary = `✅ *Perfect! Thank you ${leadData.firstName}!*\n\n📋 *Your Information:*\n📧 Email: ${leadData.email}\n📍 Address: ${leadData.address}\n💡 Monthly Bill: ${leadData.electricalBill}\n\n🎯 Our specialist will contact you within 24 hours!\n\n🌞 Get ready to save money and beat loadshedding!`;
  await sendMessage(phoneNumber, summary);
  await saveLeadWithRetry(leadData);
  setTimeout(async () => {
    await sendFollowUpMessage(phoneNumber, leadData.firstName);
  }, 120000);
  console.log('🎉 NEW LEAD CAPTURED:', leadData);
}

async function saveLeadWithRetry(leadData, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await saveLeadToEmail(leadData);
      console.log('📧 Lead emailed successfully');
      return;
    } catch (err) {
      console.error(`❌ Email send attempt ${i + 1} failed:`, err.message);
      if (i < retries - 1) {
        await sleep(2000);
      }
    }
  }
  console.error('🚨 CRITICAL: Failed to email lead data after retries.', leadData);
}

async function saveLeadToEmail(leadData) {
  const text = `🎉 NEW SOLAR LEAD CAPTURED!\n\n👤 Customer Details:\n• Name: ${leadData.firstName}\n• Phone: ${leadData.phoneNumber}\n• Email: ${leadData.email}\n• Address: ${leadData.address}\n• Monthly Bill: ${leadData.electricalBill}\n• Date: ${new Date(leadData.timestamp).toLocaleString('en-ZA')}\n\n💡 Priority: Follow up within 24 hours for best conversion!\n📞 Customer expects contact soon.\n\n---\n${CONFIG.COMPANY_NAME} WhatsApp Bot\nGenerated: ${new Date().toLocaleString('en-ZA')}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <h2 style="color:#2E8B57;">🎉 NEW SOLAR LEAD CAPTURED!</h2>
    <div style="background:#f5f5f5;padding:20px;border-radius:8px;margin:20px 0;">
      <h3 style="color:#333;">👤 Customer Details:</h3>
      <ul style="list-style:none;padding:0;">
        <li style="margin:8px 0;"><strong>Name:</strong> ${leadData.firstName}</li>
        <li style="margin:8px 0;"><strong>Phone:</strong> <a href="tel:${leadData.phoneNumber}" style="color:#2E8B57;">${leadData.phoneNumber}</a></li>
        <li style="margin:8px 0;"><strong>Email:</strong> <a href="mailto:${leadData.email}" style="color:#2E8B57;">${leadData.email}</a></li>
        <li style="margin:8px 0;"><strong>Address:</strong> ${leadData.address}</li>
        <li style="margin:8px 0;"><strong>Monthly Bill:</strong> <span style="color:#d9534f;font-weight:bold;">${leadData.electricalBill}</span></li>
        <li style="margin:8px 0;"><strong>Date:</strong> ${new Date(leadData.timestamp).toLocaleString('en-ZA')}</li>
      </ul>
    </div>
    <div style="background:#d4edda;padding:15px;border-radius:8px;border-left:4px solid #28a745;">
      <p style="margin:0;font-weight:bold;color:#155724;">💡 Priority: Follow up within 24 hours for best conversion!</p>
      <p style="margin:5px 0 0 0;color:#155724;">📞 Customer expects contact soon.</p>
    </div>
    <hr style="margin:20px 0;">
    <p style="color:#666;font-size:12px;">
      <em>${CONFIG.COMPANY_NAME} WhatsApp Bot<br>Generated: ${new Date().toLocaleString('en-ZA')}</em>
    </p>
  </div>`;
  await transporter.sendMail({
    from: `"${CONFIG.COMPANY_NAME} Bot" <${CONFIG.EMAIL_USER}>`,
    to: CONFIG.SALES_EMAIL,
    cc: CONFIG.EMAIL_USER,
    subject: `🚨 NEW SOLAR LEAD: ${leadData.firstName} - ${leadData.electricalBill} monthly bill`,
    text,
    html,
  });
}

async function sendFollowUpMessage(phoneNumber, firstName) {
  try {
    await sleep(CONFIG.RESPONSE_DELAY);
    const msg = `${firstName}, need an urgent quote? 🚀\n\nOur sales team is standing by!\n\n💬 WhatsApp for instant quotes:\n${CONFIG.SALES_PHONE}\n\n🔗 Quick contact link:\nhttps://wa.me/27843360063?text=Hi%2C%20I%27m%20${encodeURIComponent(firstName)}%20and%20I%20need%20an%20urgent%20solar%20quote\n\n⚡ Available now for same‑day quotes!\n\n🌞 Beat loadshedding with solar power!`;
    await sendMessage(phoneNumber, msg);
    console.log(`💬 Follow‑up sent to ${phoneNumber}`);
  } catch (err) {
    console.error('❌ Follow‑up failed:', err.message);
  }
}

async function sendHelpMessage(phoneNumber) {
  const msg = `🆘 *Need Help?*\n\nCommands you can use at any time:\n• Type 'restart' to start over\n• Type 'help' for this message\n• Type 'news' to get the latest solar energy headlines\n• Ask me any solar question (e.g., "How do solar panels work?")\n\nWhat we need to capture your lead:\n1. Valid email address\n2. Your first name\n3. Installation address\n4. Monthly electricity bill amount\n\nHaving issues?\nContact us directly: ${CONFIG.SALES_PHONE}\n\nEmail us: ${CONFIG.SALES_EMAIL}`;
  await sendMessage(phoneNumber, msg);
}

async function sendMessage(phoneNumber, message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.post(
        `https://graph.facebook.com/v20.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          text: { body: message },
          type: 'text',
        },
        {
          headers: {
            Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      console.log(`✅ Message sent to ${phoneNumber}`);
      return;
    } catch (err) {
      console.error(`❌ Send attempt ${i + 1} failed:`, err.response?.data || err.message);
      if (i < retries - 1) await sleep(1000);
    }
  }
}

function isValidEmail(email) {
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return regex.test(email) && email.length <= 254;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------
// Health and stats endpoints
// ----------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: userSessions.size,
    environment: process.env.NODE_ENV || 'development',
    version: '2.1.0',
  });
});

app.get('/stats', (req, res) => {
  res.json({
    activeSessions: userSessions.size,
    totalMemoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 ${CONFIG.COMPANY_NAME} Chatbot v2.1 is running on port ${PORT}`);
});
