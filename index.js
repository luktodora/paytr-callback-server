import express from "express"
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
    version: "14.0.0", // Updated version
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

// PayTR callback endpoint - POST (Server-to-Server) - Hala POST callback'leri dinliyoruz
app.post("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK POST RECEIVED ===")
  console.log("Timestamp:", new Date().toISOString())
  console.log("Headers:", JSON.stringify(req.headers, null, 2))
  console.log("Body:", JSON.stringify(req.body, null, 2))

  try {
    const { merchant_oid, status, total_amount, hash, fail_message } = req.body

    if (merchant_oid && status) {
      console.log(`📨 POST Callback received: ${merchant_oid} - ${status}`)

      // Ana uygulamaya bildirim gönder
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

      try {
        const completeOrderResponse = await fetch(`${baseUrl}/api/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderNumber: merchant_oid,
            amount: total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0,
            status: status === "success" ? "completed" : "failed",
            paymentMethod: "paytr",
            processedAt: new Date().toISOString(),
            source: "post_callback",
          }),
        })

        if (completeOrderResponse.ok) {
          console.log("✅ Order updated via POST callback")
        } else {
          console.error("❌ Failed to update order via POST callback")
        }
      } catch (error) {
        console.error("❌ Error processing POST callback:", error)
      }
    }

    res.send("OK")
  } catch (error) {
    console.error("❌ POST Callback error:", error)
    res.send("OK")
  }
})

// PayTR callback endpoint - GET (Browser Redirect) - GELİŞTİRİLMİŞ
app.get("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK GET RECEIVED ===")
  console.log("Query:", JSON.stringify(req.query, null, 2))
  console.log("Headers:", JSON.stringify(req.headers, null, 2))

  const { merchant_oid, status, total_amount } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

  console.log("GET callback values:", { merchant_oid, status, total_amount })

  // PayTR'den gelen referer kontrolü
  const referer = req.headers.referer || req.headers.referrer
  const isFromPayTR = referer && referer.includes("paytr.com")

  console.log("Referer check:", { referer, isFromPayTR })

  // Eğer query parametreleri varsa (URL'de gönderilmiş)
  if (merchant_oid && status) {
    console.log("📋 Using query parameters from URL")

    // Ana uygulamaya bildirim gönder
    try {
      const completeOrderResponse = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderNumber: merchant_oid,
          amount: total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0,
          status: status === "success" ? "completed" : "failed",
          paymentMethod: "paytr",
          processedAt: new Date().toISOString(),
          source: "get_callback_with_params",
        }),
      })

      if (completeOrderResponse.ok) {
        console.log("✅ Order updated via GET callback with params")
      }
    } catch (error) {
      console.error("❌ Error updating order via GET callback:", error)
    }

    if (status === "success") {
      const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
      const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&source=callback-params`
      console.log(`✅ Redirecting to success: ${redirectUrl}`)
      return res.redirect(redirectUrl)
    } else {
      const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=${merchant_oid}&status=${status}&source=callback-params`
      console.log(`❌ Redirecting to fail: ${redirectUrl}`)
      return res.redirect(redirectUrl)
    }
  }

  // PayTR'den geliyorsa ama parametreler yoksa - veritabanından kontrol et
  if (isFromPayTR) {
    console.log("🔍 PayTR redirect without parameters - checking database")

    try {
      // Son 10 dakikadaki pending siparişleri kontrol et
      const checkOrderResponse = await fetch(`${baseUrl}/api/orders/check-recent`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      })

      if (checkOrderResponse.ok) {
        const orderData = await checkOrderResponse.json()

        if (orderData.success && orderData.order) {
          console.log("🔄 Found recent pending order:", orderData.order.orderNumber)

          // Siparişi başarılı olarak işaretle
          const completeOrderResponse = await fetch(`${baseUrl}/api/orders`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              orderNumber: orderData.order.orderNumber,
              amount: orderData.order.amount,
              status: "completed",
              paymentMethod: "paytr",
              processedAt: new Date().toISOString(),
              source: "get_callback_database_lookup",
            }),
          })

          if (completeOrderResponse.ok) {
            console.log("✅ Order completed via database lookup")

            const redirectUrl = `${baseUrl}/odeme/basarili?siparis=${orderData.order.orderNumber}&amount=${orderData.order.amount}&source=database-lookup`
            console.log(`✅ Redirecting to success: ${redirectUrl}`)
            return res.redirect(redirectUrl)
          }
        }
      }
    } catch (error) {
      console.error("❌ Error checking database:", error)
    }

    // Veritabanından da bulunamadı
    console.log("❌ No recent order found in database")
    const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=PENDING&status=processing&source=no-database-match&info=Ödeme işleminiz kontrol ediliyor`
    console.log(`⚠️ Redirecting to processing page: ${redirectUrl}`)
    return res.redirect(redirectUrl)
  }

  // Varsayılan durum
  console.log("❌ Unknown callback type")
  const redirectUrl = `${baseUrl}/odeme/basarisiz?siparis=UNKNOWN&status=unknown&source=default`
  return res.redirect(redirectUrl)
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
      MERCHANT_KEY: process.env.PAYTR_MERCHANT_KEY ? "SET" : "MISSING",
      MERCHANT_SALT: process.env.PAYTR_MERCHANT_SALT ? "SET" : "MISSING",
    },
  })
})

// Test endpoints
app.get("/test-success", (req, res) => {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  res.redirect(`${baseUrl}/odeme/basarili?siparis=TEST123&amount=299&status=success`)
})

app.get("/test-fail", (req, res) => {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
  res.redirect(`${baseUrl}/odeme/basarisiz?siparis=TEST123&status=failed`)
})

// Server'ı başlat
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 PayTR Callback Server v14.0.0 running on port ${PORT}`)
  console.log(`📍 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🔍 Debug URL: https://paytr-callback-server-production.up.railway.app/debug`)
})
