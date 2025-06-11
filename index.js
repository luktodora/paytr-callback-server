import express from "express"
import crypto from "crypto"
import fetch from "node-fetch"

const app = express()
const PORT = process.env.PORT || 3000

// Manuel CORS ayarları
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  if (req.method === "OPTIONS") {
    return res.sendStatus(200)
  }
  next()
})

// Body parser middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// Ana sayfa
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "PayTR Callback Server is running",
    timestamp: new Date().toISOString(),
    version: "3.0.0",
  })
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

// PayTR callback endpoint - POST
app.post("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK POST RECEIVED ===")
  console.log("Timestamp:", new Date().toISOString())
  console.log("Headers:", JSON.stringify(req.headers, null, 2))
  console.log("Body:", JSON.stringify(req.body, null, 2))

  try {
    // PayTR'den gelen veriler
    const { merchant_oid, status, total_amount, hash } = req.body

    console.log("Extracted values:", {
      merchant_oid,
      status,
      total_amount,
      hash: hash ? "***" : "missing",
    })

    if (!merchant_oid || !status || !total_amount || !hash) {
      console.error("❌ Missing required fields in callback")
      return res.status(400).send("MISSING_PARAMS")
    }

    // Hash doğrulama - PayTR callback için doğru algoritma
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT

    if (!merchant_key || !merchant_salt) {
      console.error("❌ PayTR credentials missing")
      return res.status(500).send("CONFIG_ERROR")
    }

    // PayTR callback hash algoritması: merchant_oid + merchant_salt + status + total_amount
    const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
    const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

    console.log("Hash verification:", {
      merchant_oid,
      merchant_salt: merchant_salt.substring(0, 5) + "***",
      status,
      total_amount,
      hash_str,
      received_hash: hash.substring(0, 10) + "...",
      calculated_hash: calculated_hash.substring(0, 10) + "...",
      match: hash === calculated_hash,
    })

    if (hash !== calculated_hash) {
      console.error("❌ Hash verification FAILED")
      console.error("Expected hash:", calculated_hash)
      console.error("Received hash:", hash)
      console.error("Hash string:", hash_str)
      return res.status(400).send("HASH_MISMATCH")
    }

    console.log("✅ Hash verification SUCCESS")

    // Ana uygulamaya bildirim gönder
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

    try {
      if (status === "success") {
        console.log(`✅ Payment SUCCESS for order: ${merchant_oid}`)
        console.log(`💰 Amount: ${total_amount} kuruş`)

        // Siparişi tamamla
        const completeOrderResponse = await fetch(`${baseUrl}/api/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderNumber: merchant_oid,
            amount: Math.round(Number.parseInt(total_amount) / 100), // Kuruştan TL'ye çevir
            status: "completed",
            paymentMethod: "paytr",
            processedAt: new Date().toISOString(),
          }),
        })

        if (completeOrderResponse.ok) {
          console.log("✅ Order completed successfully")
        } else {
          const errorText = await completeOrderResponse.text()
          console.error("❌ Failed to complete order:", errorText)
        }
      } else {
        console.log(`❌ Payment FAILED for order: ${merchant_oid}`)
      }

      // PayTR'ye OK yanıtı döndür (her durumda)
      console.log("✅ Sending OK response to PayTR")
      return res.send("OK")
    } catch (error) {
      console.error("❌ Error processing order:", error)
      // Hata durumunda bile OK döndür
      return res.send("OK")
    }
  } catch (error) {
    console.error("❌ Callback error:", error)
    // Hata durumunda bile OK döndür
    return res.send("OK")
  }
})

// PayTR callback endpoint - GET (kullanıcı yönlendirmesi için)
app.get("/paytr-callback", (req, res) => {
  console.log("=== PAYTR CALLBACK GET RECEIVED ===")
  console.log("Query:", JSON.stringify(req.query, null, 2))

  const { merchant_oid, status, total_amount } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

  console.log("GET callback values:", { merchant_oid, status, total_amount })

  if (status === "success") {
    const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
    const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${merchant_oid || "UNKNOWN"}&amount=${amount_tl}`
    console.log(`✅ Redirecting to success: ${redirectUrl}`)
    res.redirect(redirectUrl)
  } else {
    const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=${merchant_oid || "UNKNOWN"}&status=${status || "failed"}`
    console.log(`❌ Redirecting to fail: ${redirectUrl}`)
    res.redirect(redirectUrl)
  }
})

// Debug endpoint
app.all("/debug", (req, res) => {
  res.json({
    method: req.method,
    url: req.url,
    query: req.query,
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString(),
    env: {
      PORT: process.env.PORT,
      BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
      HAS_MERCHANT_KEY: !!process.env.PAYTR_MERCHANT_KEY,
      HAS_MERCHANT_SALT: !!process.env.PAYTR_MERCHANT_SALT,
    },
  })
})

// Test hash endpoint
app.post("/test-hash", (req, res) => {
  const { merchant_oid, status, total_amount, hash } = req.body
  const merchant_key = process.env.PAYTR_MERCHANT_KEY
  const merchant_salt = process.env.PAYTR_MERCHANT_SALT

  if (!merchant_key || !merchant_salt) {
    return res.json({ error: "Missing credentials" })
  }

  const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
  const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

  res.json({
    hash_str,
    calculated_hash,
    received_hash: hash,
    match: hash === calculated_hash,
  })
})

// Test endpoints
app.get("/test-success", (req, res) => {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  console.log("🧪 TEST SUCCESS")
  res.redirect(`${baseUrl}/odeme/basarili?siparis=TEST123&amount=299&status=success`)
})

app.get("/test-fail", (req, res) => {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  console.log("🧪 TEST FAIL")
  res.redirect(`${baseUrl}/odeme/basarisiz?siparis=TEST123&status=failed`)
})

// Server'ı başlat
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 PayTR Callback Server running on port ${PORT}`)
  console.log(`📍 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🔍 Debug URL: https://paytr-callback-server-production.up.railway.app/debug`)
  console.log(`💚 Health Check: https://paytr-callback-server-production.up.railway.app/health`)
  console.log(`🧪 Test Success: https://paytr-callback-server-production.up.railway.app/test-success`)
  console.log(`🧪 Test Fail: https://paytr-callback-server-production.up.railway.app/test-fail`)
  console.log(`🔐 Test Hash: https://paytr-callback-server-production.up.railway.app/test-hash`)
  console.log(`⚙️  Environment:`, {
    BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
    HAS_MERCHANT_KEY: !!process.env.PAYTR_MERCHANT_KEY,
    HAS_MERCHANT_SALT: !!process.env.PAYTR_MERCHANT_SALT,
  })
})
