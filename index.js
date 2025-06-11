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
    version: "5.0.0",
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
      hash: hash ? hash.substring(0, 10) + "..." : "missing",
    })

    if (!merchant_oid || !status || total_amount === undefined || !hash) {
      console.error("❌ Missing required fields in callback")
      return res.status(400).send("MISSING_PARAMS")
    }

    // Environment variables kontrolü
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    // ÖNEMLİ: merchant_salt değerindeki "=" karakterini temizle
    let merchant_salt = process.env.PAYTR_MERCHANT_SALT
    if (merchant_salt && merchant_salt.startsWith("=")) {
      merchant_salt = merchant_salt.substring(1)
      console.log("⚠️ Removed '=' prefix from merchant_salt")
    }

    console.log("Environment check:", {
      merchant_key: merchant_key ? merchant_key.substring(0, 5) + "***" : "MISSING",
      merchant_salt: merchant_salt ? merchant_salt.substring(0, 5) + "***" : "MISSING",
      original_salt: process.env.PAYTR_MERCHANT_SALT
        ? process.env.PAYTR_MERCHANT_SALT.substring(0, 5) + "***"
        : "MISSING",
    })

    if (!merchant_key || !merchant_salt) {
      console.error("❌ PayTR credentials missing")
      return res.status(500).send("CONFIG_ERROR")
    }

    // PayTR callback hash algoritması: merchant_oid + merchant_salt + status + total_amount
    const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
    const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

    console.log("Hash calculation details:", {
      merchant_oid: merchant_oid,
      merchant_salt: merchant_salt,
      status: status,
      total_amount: total_amount,
      hash_string: hash_str,
      calculated_hash: calculated_hash.substring(0, 10) + "...",
      received_hash: hash.substring(0, 10) + "...",
      full_calculated: calculated_hash,
      full_received: hash,
      match: hash === calculated_hash,
    })

    if (hash !== calculated_hash) {
      console.error("❌ Hash verification FAILED")
      console.error("Expected hash:", calculated_hash)
      console.error("Received hash:", hash)
      console.error("Hash string used:", hash_str)

      // Alternatif hash hesaplama denemeleri
      console.log("🔍 Trying alternative hash calculations...")

      // Deneme 1: Orijinal salt ile
      const original_salt = process.env.PAYTR_MERCHANT_SALT
      const alt_hash_str1 = `${merchant_oid}${original_salt}${status}${total_amount}`
      const alt_calculated_hash1 = crypto.createHmac("sha256", merchant_key).update(alt_hash_str1).digest("base64")
      console.log("Alternative 1 (original salt):", {
        hash_string: alt_hash_str1,
        calculated: alt_calculated_hash1,
        match: hash === alt_calculated_hash1,
      })

      // Deneme 2: = karakteri ekleyerek
      const alt_hash_str2 = `${merchant_oid}=${merchant_salt}${status}${total_amount}`
      const alt_calculated_hash2 = crypto.createHmac("sha256", merchant_key).update(alt_hash_str2).digest("base64")
      console.log("Alternative 2 (with = prefix):", {
        hash_string: alt_hash_str2,
        calculated: alt_calculated_hash2,
        match: hash === alt_calculated_hash2,
      })

      // Eğer alternatif hesaplamalardan biri eşleşirse, devam et
      if (hash === alt_calculated_hash1) {
        console.log("✅ Alternative hash 1 matched!")
        // Devam et
      } else if (hash === alt_calculated_hash2) {
        console.log("✅ Alternative hash 2 matched!")
        // Devam et
      } else {
        return res.status(400).send("HASH_MISMATCH")
      }
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

  // Eğer query parametreleri boşsa, URL'den parse etmeyi dene
  if (!merchant_oid && !status) {
    const url = req.url
    console.log("Trying to parse parameters from URL:", url)

    // URL'den parametreleri çıkarmaya çalış
    const urlParams = new URLSearchParams(url.split("?")[1] || "")
    const parsedMerchantOid = urlParams.get("merchant_oid")
    const parsedStatus = urlParams.get("status")
    const parsedTotalAmount = urlParams.get("total_amount")

    console.log("Parsed from URL:", {
      merchant_oid: parsedMerchantOid,
      status: parsedStatus,
      total_amount: parsedTotalAmount,
    })

    if (parsedMerchantOid && parsedStatus) {
      if (parsedStatus === "success") {
        const amount_tl = parsedTotalAmount ? Math.round(Number.parseInt(parsedTotalAmount) / 100) : 0
        const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${parsedMerchantOid}&amount=${amount_tl}`
        console.log(`✅ Redirecting to success (parsed): ${redirectUrl}`)
        return res.redirect(redirectUrl)
      } else {
        const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=${parsedMerchantOid}&status=${parsedStatus}`
        console.log(`❌ Redirecting to fail (parsed): ${redirectUrl}`)
        return res.redirect(redirectUrl)
      }
    }
  }

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
  // Environment variables kontrolü
  const merchant_key = process.env.PAYTR_MERCHANT_KEY
  // ÖNEMLİ: merchant_salt değerindeki "=" karakterini temizle
  let merchant_salt = process.env.PAYTR_MERCHANT_SALT
  const original_salt = process.env.PAYTR_MERCHANT_SALT

  if (merchant_salt && merchant_salt.startsWith("=")) {
    merchant_salt = merchant_salt.substring(1)
  }

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
      MERCHANT_KEY: merchant_key ? merchant_key.substring(0, 5) + "***" : "MISSING",
      MERCHANT_SALT: merchant_salt ? merchant_salt.substring(0, 5) + "***" : "MISSING",
      ORIGINAL_SALT: original_salt ? original_salt.substring(0, 5) + "***" : "MISSING",
      SALT_FIXED: merchant_salt !== original_salt,
    },
  })
})

// Test hash endpoint
app.post("/test-hash", (req, res) => {
  const { merchant_oid, status, total_amount, hash } = req.body
  const merchant_key = process.env.PAYTR_MERCHANT_KEY

  // ÖNEMLİ: merchant_salt değerindeki "=" karakterini temizle
  let merchant_salt = process.env.PAYTR_MERCHANT_SALT
  const original_salt = process.env.PAYTR_MERCHANT_SALT

  if (merchant_salt && merchant_salt.startsWith("=")) {
    merchant_salt = merchant_salt.substring(1)
  }

  if (!merchant_key || !merchant_salt) {
    return res.json({ error: "Missing credentials" })
  }

  const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
  const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

  // Alternatif hash hesaplama
  const alt_hash_str = `${merchant_oid}${original_salt}${status}${total_amount}`
  const alt_calculated_hash = crypto.createHmac("sha256", merchant_key).update(alt_hash_str).digest("base64")

  res.json({
    merchant_oid,
    merchant_salt,
    original_salt,
    status,
    total_amount,
    hash_str,
    calculated_hash,
    alt_hash_str,
    alt_calculated_hash,
    received_hash: hash,
    match: hash === calculated_hash,
    alt_match: hash === alt_calculated_hash,
    env_check: {
      merchant_key: merchant_key ? "SET" : "MISSING",
      merchant_salt: merchant_salt ? "SET" : "MISSING",
      salt_fixed: merchant_salt !== original_salt,
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
  console.log(`🔐 Test Hash: https://paytr-callback-server-production.up.railway.app/test-hash`)

  // Environment variables kontrolü
  const merchant_key = process.env.PAYTR_MERCHANT_KEY
  // ÖNEMLİ: merchant_salt değerindeki "=" karakterini temizle
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
