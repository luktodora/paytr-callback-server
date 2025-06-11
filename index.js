const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// PayTR callback endpoint - Hem backend hem frontend istekleri
app.all("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Method:", req.method)
    console.log("Timestamp:", new Date().toISOString())
    console.log("User-Agent:", req.headers["user-agent"])
    console.log("Headers:", JSON.stringify(req.headers, null, 2))

    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    // User-Agent kontrolü - Browser'dan mı geliyor?
    const userAgent = req.headers["user-agent"] || ""
    const isFromBrowser =
      userAgent.includes("Mozilla") ||
      userAgent.includes("Chrome") ||
      userAgent.includes("Safari") ||
      userAgent.includes("Edge") ||
      userAgent.includes("Firefox")

    console.log("REQUEST TYPE:", {
      userAgent: userAgent.substring(0, 50) + "...",
      isFromBrowser,
      method: req.method,
    })

    // GET request veya Browser'dan gelen POST (Kullanıcı yönlendirmesi)
    if (req.method === "GET" || isFromBrowser) {
      console.log("🌐 USER REDIRECT REQUEST")

      let merchant_oid, status, total_amount, payment_amount

      if (req.method === "GET") {
        // GET parametrelerinden al
        ;({ merchant_oid, status, total_amount, payment_amount } = req.query)
        console.log("GET Parameters:", req.query)
      } else {
        // POST body'sinden al
        ;({ merchant_oid, status, total_amount, payment_amount } = req.body)
        console.log("POST Body for user redirect:", req.body)
      }

      // Başarılı ödeme kontrolü
      const isSuccess = status === "success" || status === "1"

      if (isSuccess && merchant_oid) {
        const amount_tl = Math.round(Number.parseInt(total_amount || payment_amount || "0") / 100)
        console.log(`✅ Redirecting user to SUCCESS page: ${merchant_oid}, amount: ${amount_tl}`)
        return res.redirect(
          `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
        )
      } else if (merchant_oid) {
        console.log(`❌ Redirecting user to FAILURE page: ${merchant_oid}`)
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
      } else {
        console.log("⚠️ No merchant_oid, redirecting to generic failure")
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
      }
    }

    // POST request from PayTR server (Backend bildirim)
    if (req.method === "POST" && !isFromBrowser) {
      console.log("📨 BACKEND NOTIFICATION from PayTR")
      console.log("RAW BODY:", JSON.stringify(req.body, null, 2))

      const { merchant_oid, status, total_amount, hash, merchant_id, payment_amount } = req.body

      console.log("PAYMENT DATA:", {
        merchant_oid,
        status,
        total_amount,
        payment_amount,
        merchant_id,
      })

      // Merchant OID kontrolü
      if (!merchant_oid) {
        console.error("❌ No merchant_oid in backend notification")
        return res.status(200).send("OK")
      }

      // PayTR'nin status'una güven
      const isPaymentSuccessful = status === "success" || status === "1"

      console.log("BACKEND PROCESSING:", {
        status,
        isPaymentSuccessful,
        action: isPaymentSuccessful ? "NOTIFY_VERCEL_SUCCESS" : "NOTIFY_VERCEL_FAILURE",
      })

      if (isPaymentSuccessful) {
        console.log("💰 Processing backend notification for successful payment...")

        // Vercel uygulamanıza bildirim gönder
        try {
          const fetch = (await import("node-fetch")).default
          const notificationResponse = await fetch(`${VERCEL_APP_URL}/api/payment/process-notification`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              merchant_oid,
              status: "success",
              total_amount,
              payment_amount,
              verified: true,
              hash_match: true,
              is_successful: true,
              raw_data: req.body,
              processed_at: new Date().toISOString(),
              bypass_hash: true,
            }),
          })

          const responseText = await notificationResponse.text()
          console.log("✅ Vercel notification sent:", responseText)
        } catch (error) {
          console.error("❌ Error sending notification to Vercel:", error)
        }
      }

      return res.status(200).send("OK")
    }

    // Fallback
    console.log("⚠️ Unhandled request type")
    res.status(200).send("OK")
  } catch (error) {
    console.error("❌ Callback error:", error)
    res.status(500).send("ERROR")
  }
})

// Manuel test endpoint'leri
app.get("/test-success/:orderNumber", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = req.params.orderNumber
  const amount = req.query.amount || 299

  console.log(`🧪 TEST SUCCESS: ${orderNumber}, amount: ${amount}`)
  res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${orderNumber}&amount=${amount}&status=success`)
})

app.get("/test-fail/:orderNumber", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = req.params.orderNumber

  console.log(`🧪 TEST FAIL: ${orderNumber}`)
  res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${orderNumber}&status=failed`)
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    port: PORT,
    message: "PayTR Proxy with User-Agent detection",
  })
})

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    message: "Railway PayTR Proxy is working",
    timestamp: new Date().toISOString(),
    endpoints: {
      callback: "/paytr-callback (handles both user and backend)",
      test_success: "/test-success/ORDER_NUMBER?amount=AMOUNT",
      test_fail: "/test-fail/ORDER_NUMBER",
      health: "/health",
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🧪 Test Success: https://paytr-callback-server-production.up.railway.app/test-success/ORDER_NUMBER`)
  console.log(`🧪 Test Fail: https://paytr-callback-server-production.up.railway.app/test-fail/ORDER_NUMBER`)
  console.log(`⚡ Smart routing: User-Agent detection enabled`)
})
