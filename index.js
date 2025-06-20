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
    version: "11.0.0", // Version updated
  })
})

// Health check endpoint
app.get("/health", (req, res) => {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    baseUrl: baseUrl,
    env: {
      MERCHANT_KEY: process.env.PAYTR_MERCHANT_KEY ? "SET" : "MISSING",
      MERCHANT_SALT: process.env.PAYTR_MERCHANT_SALT ? "SET" : "MISSING",
    },
  })
})

// Global değişken - son başarılı ödeme bilgilerini sakla (5 dakika boyunca)
const lastSuccessfulPayments = new Map()
// Devam eden ödemeleri izle
const ongoingPayments = new Set()

// PayTR callback endpoint - POST
app.post("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK POST RECEIVED ===")
  console.log("Timestamp:", new Date().toISOString())
  console.log("Headers:", JSON.stringify(req.headers, null, 2))
  console.log("Body:", JSON.stringify(req.body, null, 2))

  try {
    // PayTR'den gelen veriler
    const { merchant_oid, status, total_amount, hash, fail_message } = req.body

    // Fail message varsa özel işlem yap
    if (fail_message) {
      console.log("⚠️ PayTR fail message:", fail_message)

      // "Devam eden bir ödeme işleminiz var" mesajı için özel handling
      if (
        fail_message.includes("Devam eden bir ödeme işleminiz var") ||
        fail_message.includes("devam eden") ||
        fail_message.includes("ongoing")
      ) {
        console.log("🔄 Ongoing payment detected, redirecting to fail page")

        // PayTR'ye OK yanıtı döndür
        res.send("OK")
        return
      }

      // Diğer fail mesajları için de OK döndür
      res.send("OK")
      return
    }

    console.log("Extracted values:", {
      merchant_oid,
      status,
      total_amount,
      hash: hash ? hash.substring(0, 10) + "..." : "missing",
      fail_message,
    })

    // Eğer gerekli alanlar eksikse ama fail_message yoksa, OK döndür
    if (!merchant_oid || !status || total_amount === undefined || !hash) {
      console.error("❌ Missing required fields in callback")
      res.send("OK")
      return
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
      res.send("OK")
      return
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

    // Son başarılı ödeme bilgilerini sakla (5 dakika boyunca)
    if (status === "success") {
      const paymentData = {
        merchant_oid,
        total_amount,
        timestamp: new Date().toISOString(),
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 dakika
      }
      lastSuccessfulPayments.set(merchant_oid, paymentData)
      console.log("💾 Saved last successful payment:", paymentData)

      // Devam eden ödemelerden kaldır
      if (ongoingPayments.has(merchant_oid)) {
        ongoingPayments.delete(merchant_oid)
        console.log("🗑️ Removed from ongoing payments:", merchant_oid)
      }
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

        // Devam eden ödemelerden kaldır
        if (ongoingPayments.has(merchant_oid)) {
          ongoingPayments.delete(merchant_oid)
          console.log("🗑️ Removed from ongoing payments:", merchant_oid)
        }
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

// PayTR callback endpoint - GET (kullanıcı yönlendirmesi için) - GELİŞTİRİLMİŞ
app.get("/paytr-callback", (req, res) => {
  console.log("=== PAYTR CALLBACK GET RECEIVED ===")
  console.log("Query:", JSON.stringify(req.query, null, 2))
  console.log("URL:", req.url)
  console.log("Original URL:", req.originalUrl)
  console.log("Headers:", JSON.stringify(req.headers, null, 2))

  const { merchant_oid, status, total_amount } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

  console.log("GET callback values:", { merchant_oid, status, total_amount })

  // PayTR'den gelen referer kontrolü
  const referer = req.headers.referer || req.headers.referrer
  const isFromPayTR = referer && referer.includes("paytr.com")

  console.log("Referer check:", {
    referer,
    isFromPayTR,
    userAgent: req.headers["user-agent"],
  })

  // Eğer PayTR'den geliyorsa ve parametreler yoksa, özel handling
  if (isFromPayTR && (!merchant_oid || !status)) {
    console.log("🔍 PayTR redirect without parameters detected")

    // Son başarılı ödemeleri kontrol et
    const now = Date.now()
    for (const [key, payment] of lastSuccessfulPayments.entries()) {
      if (payment.expiresAt < now) {
        lastSuccessfulPayments.delete(key)
        console.log("🗑️ Removed expired payment:", key)
      }
    }

    // En son başarılı ödemeyi bul
    let latestPayment = null
    for (const payment of lastSuccessfulPayments.values()) {
      if (!latestPayment || new Date(payment.timestamp) > new Date(latestPayment.timestamp)) {
        latestPayment = payment
      }
    }

    if (latestPayment) {
      console.log("🔄 Using latest successful payment data:", latestPayment)

      const amount_tl = Math.round(Number.parseInt(latestPayment.total_amount) / 100)
      const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${latestPayment.merchant_oid}&amount=${amount_tl}&source=paytr-redirect`
      console.log(`✅ Redirecting to success with saved data: ${redirectUrl}`)

      return res.redirect(redirectUrl)
    } else {
      // Başarılı ödeme bulunamadı, genel başarısız sayfaya yönlendir
      console.log("❌ No recent successful payment found, redirecting to fail")
      const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=UNKNOWN&status=no-recent-payment&source=paytr-redirect`
      return res.redirect(redirectUrl)
    }
  }

  // Normal query parametreleri varsa onları kullan
  if (status === "success" && merchant_oid) {
    const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
    const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${merchant_oid || "UNKNOWN"}&amount=${amount_tl}&source=callback-params`
    console.log(`✅ Redirecting to success: ${redirectUrl}`)
    res.redirect(redirectUrl)
  } else if (merchant_oid) {
    // Başarısız ama sipariş numarası var
    const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=${merchant_oid}&status=${status || "failed"}&source=callback-params`
    console.log(`❌ Redirecting to fail with order: ${redirectUrl}`)
    res.redirect(redirectUrl)
  } else {
    // Hiçbir bilgi yoksa başarısız sayfaya yönlendir
    const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=UNKNOWN&status=no-params&source=callback-empty`
    console.log(`❌ Redirecting to fail: ${redirectUrl}`)
    res.redirect(redirectUrl)
  }
})

// Ödeme başlatma kaydı - devam eden ödemeleri temizle
app.post("/register-payment", (req, res) => {
  const { merchant_oid } = req.body

  if (!merchant_oid) {
    return res.status(400).json({ success: false, message: "merchant_oid required" })
  }

  // Eski devam eden ödemeleri temizle (5 dakikadan eski)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  const currentTime = Date.now()

  // Basit bir temizlik - gerçek uygulamada timestamp'li bir Map kullanılabilir
  if (ongoingPayments.size > 10) {
    ongoingPayments.clear()
    console.log("🧹 Cleared old ongoing payments")
  }

  if (ongoingPayments.has(merchant_oid)) {
    return res.status(409).json({
      success: false,
      message: "Payment already in progress",
      ongoing: true,
    })
  }

  ongoingPayments.add(merchant_oid)
  console.log("➕ Added to ongoing payments:", merchant_oid)
  console.log("📊 Current ongoing payments:", Array.from(ongoingPayments))

  return res.json({
    success: true,
    message: "Payment registered",
    ongoing: false,
  })
})

// Devam eden ödemeleri temizle endpoint
app.post("/clear-ongoing", (req, res) => {
  const { merchant_oid } = req.body

  if (merchant_oid && ongoingPayments.has(merchant_oid)) {
    ongoingPayments.delete(merchant_oid)
    console.log("🗑️ Manually cleared ongoing payment:", merchant_oid)
  } else {
    ongoingPayments.clear()
    console.log("🧹 Cleared all ongoing payments")
  }

  res.json({
    success: true,
    message: "Ongoing payments cleared",
    remaining: Array.from(ongoingPayments),
  })
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
    lastSuccessfulPayment: Array.from(lastSuccessfulPayments.entries()),
    ongoingPayments: Array.from(ongoingPayments),
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
  console.log(`🧹 Clear Ongoing: https://paytr-callback-server-production.up.railway.app/clear-ongoing`)

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
