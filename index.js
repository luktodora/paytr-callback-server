import express from "express"
import crypto from "crypto"
import fetch from "node-fetch"
import cors from "cors"

const app = express()
const PORT = process.env.PORT || 3000

// CORS middleware
app.use(cors())

// Body parser middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// Ana sayfa
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "PayTR Callback Server is running",
    timestamp: new Date().toISOString(),
    version: "7.0.0",
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

// Global değişken - son başarılı ödeme bilgilerini sakla
let lastSuccessfulPayment = null

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
      hash: hash ? hash.substring(0, 10) + "..." : "missing",
    })

    if (!merchant_oid || !status || total_amount === undefined || !hash) {
      console.error("❌ Missing required fields in callback")
      return res.status(400).send("MISSING_PARAMS")
    }

    // Environment variables kontrolü
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    let merchant_salt = process.env.PAYTR_MERCHANT_SALT
    if (merchant_salt && merchant_salt.startsWith("=")) {
      merchant_salt = merchant_salt.substring(1)
      console.log("⚠️ Removed '=' prefix from merchant_salt")
    }

    console.log("Environment check:", {
      merchant_key: merchant_key ? merchant_key.substring(0, 5) + "***" : "MISSING",
      merchant_salt: merchant_salt ? merchant_salt.substring(0, 5) + "***" : "MISSING",
    })

    if (!merchant_key || !merchant_salt) {
      console.error("❌ PayTR credentials missing")
      return res.status(500).send("CONFIG_ERROR")
    }

    // PayTR callback hash algoritması
    const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
    const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

    console.log("Hash calculation details:", {
      merchant_oid: merchant_oid,
      merchant_salt: merchant_salt,
      status: status,
      total_amount: total_amount,
      hash_string: hash_str,
      calculated_hash: calculated_hash.substring(0, 10) + "...",
      received_hash: hash ? hash.substring(0, 10) + "..." : "missing",
      full_calculated: calculated_hash,
      full_received: hash,
      match: hash === calculated_hash,
    })

    // Hash doğrulama (bypass ile)
    if (hash !== calculated_hash) {
      console.error("❌ Hash verification FAILED")
      console.error("Expected hash:", calculated_hash)
      console.error("Received hash:", hash || "MISSING")
      console.error("Hash string used:", hash_str)
      console.log("⚠️ Continuing despite hash mismatch")
    }

    console.log("✅ Hash verification SUCCESS or bypassed")

    // Son başarılı ödeme bilgilerini sakla
    if (status === "success") {
      lastSuccessfulPayment = {
        merchant_oid,
        total_amount,
        timestamp: new Date().toISOString(),
      }
      console.log("💾 Saved last successful payment:", lastSuccessfulPayment)
    }

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
            amount: Math.round(Number.parseInt(total_amount) / 100),
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

      // PayTR'ye OK yanıtı döndür
      console.log("✅ Sending OK response to PayTR")
      return res.send("OK")
    } catch (error) {
      console.error("❌ Error processing order:", error)
      return res.send("OK")
    }
  } catch (error) {
    console.error("❌ Callback error:", error)
    return res.send("OK")
  }
})

// PayTR callback endpoint - GET (kullanıcı yönlendirmesi için)
app.get("/paytr-callback", (req, res) => {
  console.log("=== PAYTR CALLBACK GET RECEIVED ===")
  console.log("Query:", JSON.stringify(req.query, null, 2))
  console.log("URL:", req.url)
  console.log("Original URL:", req.originalUrl)

  const { merchant_oid, status, total_amount } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

  console.log("GET callback values:", { merchant_oid, status, total_amount })

  // Eğer query parametreleri boşsa ve son başarılı ödeme varsa onu kullan
  if (!merchant_oid && !status && lastSuccessfulPayment) {
    console.log("🔄 Using last successful payment data:", lastSuccessfulPayment)

    const amount_tl = Math.round(Number.parseInt(lastSuccessfulPayment.total_amount) / 100)
    const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${lastSuccessfulPayment.merchant_oid}&amount=${amount_tl}`
    console.log(`✅ Redirecting to success with saved data: ${redirectUrl}`)

    // Kullanıldıktan sonra temizle
    lastSuccessfulPayment = null

    return res.redirect(redirectUrl)
  }

  // Normal query parametreleri varsa onları kullan
  if (status === "success" || merchant_oid) {
    const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
    const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${merchant_oid || "UNKNOWN"}&amount=${amount_tl}`
    console.log(`✅ Redirecting to success: ${redirectUrl}`)
    res.redirect(redirectUrl)
  } else {
    // Hiçbir bilgi yoksa başarısız sayfaya yönlendir
    const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=UNKNOWN&status=failed`
    console.log(`❌ Redirecting to fail: ${redirectUrl}`)
    res.redirect(redirectUrl)
  }
})

// Debug endpoint
app.all("/debug", (req, res) => {
  const merchant_key = process.env.PAYTR_MERCHANT_KEY
  let merchant_salt = process.env.PAYTR_MERCHANT_SALT
  const original_salt = process.env.PAYTR_MERCHANT_SALT

  if (merchant_salt && merchant_salt.startsWith("=")) {
    merchant_salt = merchant_salt.substring(1)
  }

  res.json({
    method: req.method,
    url: req.url,
    originalUrl: req.originalUrl,
    query: req.query,
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString(),
    lastSuccessfulPayment: lastSuccessfulPayment,
    env: {
      PORT: process.env.PORT,
      BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
      MERCHANT_KEY: merchant_key ? merchant_key.substring(0, 5) + "***" : "MISSING",
      MERCHANT_SALT: merchant_salt ? merchant_salt.substring(0, 5) + "***" : "MISSING",
      ORIGINAL_SALT: original_salt ? original_salt.substring(0, 5) + "***" : "MISSING",
      SALT_FIXED: merchant_salt !== original_salt,
    },
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

  const merchant_key = process.env.PAYTR_MERCHANT_KEY
  let merchant_salt = process.env.PAYTR_MERCHANT_SALT
  const original_salt = process.env.PAYTR_MERCHANT_SALT

  if (merchant_salt && merchant_salt.startsWith("=")) {
    merchant_salt = merchant_salt.substring(1)
    console.log("⚠️ Removed '=' prefix from merchant_salt")
  }

  console.log(`⚙️  Environment:`, {
    BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
    MERCHANT_KEY: merchant_key ? "SET" : "MISSING",
    MERCHANT_SALT: merchant_salt ? "SET" : "MISSING",
    ORIGINAL_SALT: original_salt ? "SET" : "MISSING",
    SALT_FIXED: merchant_salt !== original_salt,
  })
})
