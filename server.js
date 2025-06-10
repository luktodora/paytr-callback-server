const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// PayTR Callback endpoint
app.post('/paytr-callback', (req, res) => {
  console.log('PayTR POST request received:', req.body);
  console.log('Headers:', req.headers);
  
  // PayTR'ye başarılı yanıt döndür
  res.status(200).send('OK');
});

// Müşteri yönlendirme endpoint'i
app.get('/paytr-callback', (req, res) => {
  console.log('PayTR GET request received:', req.query);
  
  const siparis = req.query.merchant_oid || req.query.siparis || 'TEST-' + Date.now();
  const status = req.query.status || 'success';
  
  // Ana siteye yönlendir
  const redirectUrl = `https://mapsyorum.com.tr/odeme/basarili?siparis=${siparis}&status=${status}`;
  console.log('Redirecting to:', redirectUrl);
  
  res.redirect(redirectUrl);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.send('PayTR Callback Server is running!');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
