import express from "express"
import crypto from "crypto"
import fetch from "node-fetch"
import cors from "cors"

const app = express()
const PORT = process.env.PORT || 3000

// CORS middleware
app.use(cors())

// Raw body capture middleware (POST callback debug için)
app.use("/paytr-callback", (req, res, next) => {
  if (req.method === "POST") {
    let rawBody = ""
    req.on("data", (chunk) => {
      rawBody += chunk.toString()
    })
    req.on("end", () => {
      req.rawBody = rawBody
      console.log("=== RAW POST DATA RECEIVED ===")
      console.log("Raw Body Length:", rawBody.length)
      console.log("Raw Body:", rawBody)
      console.log("Content-Type:", req.headers["content-type"])
      next()
    })
  } else {
    next()
  }
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
    version: "13.0.0", // Version updated for enhanced logging
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

// Global değişken - ödeme bilgilerini sakla
const paymentData = new Map() // merchant_oid -> payment info
const pendingRedirects = new Map() // IP -> redirect info
const allRequests = [] // Tüm istekleri logla

// Tüm istekleri logla
app.use((req, res, next) => {
  const requestLog = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: req.body,
    rawBody: req.rawBody,
    ip: req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.connection.remoteAddress,
  }

  allRequests.push(requestLog)

  // Son 100 isteği sakla
  if (allRequests.length > 100) {
    allRequests.shift()
  }

  console.log(`=== ${req.method} ${req.url} ===`)
  console.log("From IP:", requestLog.ip)
  console.log("User-Agent:", req.headers["user-agent"])
  console.log("Referer:", req.headers["referer"])

  next()
})

// PayTR callback endpoint - POST (Server-to-Server)
app.post("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK POST RECEIVED ===")
  console.log("Timestamp:", new Date().toISOString())
  console.log("Headers:", JSON.stringify(req.headers, null, 2))
  console.log("Body:", JSON.stringify(req.body, null, 2))
  console.log("Raw Body:", req.rawBody)

  try {
    // PayTR'den gelen veriler
    const { merchant_oid, status, total_amount, hash, fail_message } = req.body

    console.log("POST Callback - Extracted values:", {
      merchant_oid,
      status,
      total_amount,
      hash: hash ? hash.substring(0, 10) + "..." : "missing",
      fail_message,
    })

    // Ödeme bilgilerini kaydet (GET callback için)
    if (merchant_oid && status) {
      const paymentInfo = {
        merchant_oid,
        status,
        total_amount: total_amount || "0",
        timestamp: new Date().toISOString(),
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 dakika
        processed: false,
      }

      paymentData.set(merchant_oid, paymentInfo)
      console.log("💾 Saved payment data for GET callback:", paymentInfo)
    }

    // Fail message varsa özel işlem yap
    if (fail_message) {
      console.log("⚠️ PayTR fail message:", fail_message)
      res.send("OK")
      return
    }

    // Gerekli alanlar kontrolü
    if (!merchant_oid || !status || total_amount === undefined) {
      console.error("❌ Missing required fields in POST callback")
      res.send("OK")
      return
    }

    // Environment variables kontrolü
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    let merchant_salt = process.env.PAYTR_MERCHANT_SALT
    if (merchant_salt && merchant_salt.startsWith("=")) {
      merchant_salt = merchant_salt.substring(1)
    }

    if (!merchant_key || !merchant_salt) {
      console.error("❌ PayTR credentials missing")
      res.send("OK")
      return
    }

    // Hash doğrulama (opsiyonel)
    if (hash) {
      const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
      const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

      if (hash !== calculated_hash) {
        console.error("❌ Hash verification FAILED")
        console.log("⚠️ Continuing despite hash mismatch")
      } else {
        console.log("✅ Hash verification SUCCESS")
      }
    }

    // Ana uygulamaya bildirim gönder
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

    try {
      if (status === "success") {
        console.log(`✅ Payment SUCCESS for order: ${merchant_oid}`)

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
          // İşlendiğini işaretle
          if (paymentData.has(merchant_oid)) {
            paymentData.get(merchant_oid).processed = true
          }
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
    console.error("❌ POST Callback error:", error)
    return res.send("OK")
  }
})

// PayTR callback endpoint - GET (Browser Redirect)
app.get("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK GET RECEIVED ===")
  console.log("Query:", JSON.stringify(req.query, null, 2))
  console.log("Headers:", JSON.stringify(req.headers, null, 2))

  const { merchant_oid, status, total_amount } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  const clientIP = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.connection.remoteAddress

  console.log("GET callback values:", { merchant_oid, status, total_amount, clientIP })

  // PayTR'den gelen referer kontrolü
  const referer = req.headers.referer || req.headers.referrer
  const isFromPayTR = referer && referer.includes("paytr.com")

  console.log("Referer check:", { referer, isFromPayTR })

  // Süresi dolmuş ödeme bilgilerini temizle
  const now = Date.now()
  for (const [key, payment] of paymentData.entries()) {
    if (payment.expiresAt < now) {
      paymentData.delete(key)
      console.log("🗑️ Removed expired payment:", key)
    }
  }

  // Eğer query parametreleri varsa onları kullan
  if (merchant_oid && status) {
    console.log("📋 Using query parameters")

    if (status === "success") {
      const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
      const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&source=query-params`
      console.log(`✅ Redirecting to success: ${redirectUrl}`)
      return res.redirect(redirectUrl)
    } else {
      const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=${merchant_oid}&status=${status}&source=query-params`
      console.log(`❌ Redirecting to fail: ${redirectUrl}`)
      return res.redirect(redirectUrl)
    }
  }

  // PayTR'den geliyorsa ve parametreler yoksa
  if (isFromPayTR) {
    console.log("🔍 PayTR redirect without parameters detected")

    // Bekleyen redirect bilgisini kaydet
    const redirectInfo = {
      timestamp: Date.now(),
      ip: clientIP,
      userAgent: req.headers["user-agent"],
    }
    pendingRedirects.set(clientIP, redirectInfo)

    // Kısa bir süre bekle (POST callback gelebilir)
    console.log("⏳ Waiting for potential POST callback...")

    await new Promise((resolve) => setTimeout(resolve, 3000)) // 3 saniye bekle

    // Tekrar kontrol et
    let foundPayment = null

    // Son 5 dakikadaki başarılı ödemeleri kontrol et
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    for (const [oid, payment] of paymentData.entries()) {
      if (payment.status === "success" && new Date(payment.timestamp).getTime() > fiveMinutesAgo) {
        if (!foundPayment || new Date(payment.timestamp) > new Date(foundPayment.timestamp)) {
          foundPayment = payment
        }
      }
    }

    if (foundPayment) {
      console.log("🔄 Using recent successful payment:", foundPayment)

      const amount_tl = Math.round(Number.parseInt(foundPayment.total_amount) / 100)
      const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${foundPayment.merchant_oid}&amount=${amount_tl}&source=recent-payment`
      console.log(`✅ Redirecting to success: ${redirectUrl}`)

      return res.redirect(redirectUrl)
    } else {
      // Başarılı ödeme bulunamadı
      console.log("❌ No recent successful payment found")

      // Genel bir başarısız sayfaya yönlendir ama daha az agresif
      const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=PENDING&status=processing&source=no-recent-payment&info=Ödeme işleminiz kontrol ediliyor`
      console.log(`⚠️ Redirecting to processing page: ${redirectUrl}`)

      return res.redirect(redirectUrl)
    }
  }

  // Varsayılan durum
  console.log("❌ Unknown callback type, redirecting to fail")
  const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=UNKNOWN&status=unknown&source=default`
  return res.redirect(redirectUrl)
})

// Debug endpoint - tüm istekleri göster
app.all("/debug", (req, res) => {
  res.json({
    method: req.method,
    url: req.url,
    query: req.query,
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString(),
    paymentData: Array.from(paymentData.entries()),
    pendingRedirects: Array.from(pendingRedirects.entries()),
    allRequests: allRequests.slice(-20), // Son 20 istek
    env: {
      PORT: process.env.PORT,
      BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
      MERCHANT_KEY: process.env.PAYTR_MERCHANT_KEY ? "SET" : "MISSING",
      MERCHANT_SALT: process.env.PAYTR_MERCHANT_SALT ? "SET" : "MISSING",
    },
  })
})

// Test POST callback endpoint
app.post("/test-post-callback", (req, res) => {
  console.log("=== TEST POST CALLBACK ===")
  console.log("Headers:", JSON.stringify(req.headers, null, 2))
  console.log("Body:", JSON.stringify(req.body, null, 2))
  console.log("Raw Body:", req.rawBody)

  res.send("OK")
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
  console.log(`🚀 PayTR Callback Server v13.0.0 running on port ${PORT}`)
  console.log(`📍 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🔍 Debug URL: https://paytr-callback-server-production.up.railway.app/debug`)
  console.log(`💚 Health Check: https://paytr-callback-server-production.up.railway.app/health`)
  console.log(`🧪 Test POST: https://paytr-callback-server-production.up.railway.app/test-post-callback`)
})
