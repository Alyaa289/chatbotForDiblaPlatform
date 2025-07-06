const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const twilio = require('twilio');
const app = express();

app.use(express.json());

// Twilio configuration (optional for WhatsApp)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

// Schema for Customer Guide
const GuideSchema = new mongoose.Schema({
  content: String, // e.g., "To add a product to your wishlist, click the heart icon."
  embedding: [Number], // Vector embedding for the content
});
const Guide = mongoose.model('Guide', GuideSchema);

// JWT authentication middleware
const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Encrypt sensitive data (e.g., user queries for logging)
const encryptData = (data) => {
  const cipher = crypto.createCipher('aes-256-cbc', process.env.ENCRYPTION_KEY);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
};

// Generate embeddings for text (English or Arabic)
const getEmbedding = async (text) => {
  try {
    const response = await axios.post(
      'https://api.huggingface.co/models/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      { inputs: text },
      { headers: { Authorization: `Bearer ${process.env.HF_API_TOKEN}` } }
    );
    return response.data.embedding;
  } catch (err) {
    console.error('Error generating embedding:', err);
    throw err;
  }
};

// Load Customer Guide into MongoDB (run once or on update)
const loadCustomerGuide = async () => {
  const guideContent = [
    'To add a product to your wishlist, click the heart icon next to the product.',
    'To visit a store, select the store from the list and click "Visit".',
    'To navigate, use the search bar at the top or browse categories.',
    'لإضافة منتج إلى قائمة الرغبات، اضغط على أيقونة القلب بجوار المنتج.', // Arabic version
    'لزيارة متجر، اختر المتجر من القائمة واضغط على "زيارة".',
    'للتصفح، استخدم شريط البحث في الأعلى أو تصفح الفئات.',
    // Add more guide content as needed
  ];

  for (const content of guideContent) {
    const embedding = await getEmbedding(content);
    await Guide.findOneAndUpdate(
      { content },
      { content, embedding },
      { upsert: true }
    );
  }
};

// Chatbot endpoint
app.post('/chat', authenticateJWT, async (req, res) => {
  try {
    const { query, viaWhatsApp } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    // Encrypt query for logging
    const encryptedQuery = encryptData(query);

    // Get query embedding (works for English or Arabic)
    const queryEmbedding = await getEmbedding(query);

    // Retrieve relevant documents from MongoDB
    const relevantDocs = await Guide.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index', // Requires vector index in MongoDB
          queryVector: queryEmbedding,
          path: 'embedding',
          limit: 3,
        },
      },
    ]);

    // Combine relevant documents into context
    const context = relevantDocs.map(doc => doc.content).join('\n');

    // Call language model (e.g., xAI Grok API)
    const llmResponse = await axios.post(
      'https://api.x.ai/grok',
      {
        prompt: `Context: ${context}\n\nUser Query: ${query}\n\nProvide a concise and accurate response in the same language as the query.`,
      },
      { headers: { Authorization: `Bearer ${process.env.XAI_API_TOKEN}` } }
    );

    const responseText = llmResponse.data.response;

    // Send response via WhatsApp if requested
    if (viaWhatsApp) {
      await twilioClient.messages.create({
        body: responseText,
        from: 'whatsapp:+1234567890', // Your Twilio WhatsApp number
        to: `whatsapp:${req.user.phoneNumber}`,
      });
    }

    res.json({ response: responseText });
  } catch (err) {
    console.error('Chatbot error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize Customer Guide
loadCustomerGuide().catch(console.error);

// Start server
app.listen(3001, () => console.log('Chatbot running on port 3001'));