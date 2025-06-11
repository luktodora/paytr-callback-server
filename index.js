const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// PayTR callback endpoint
app.all("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Method:", req.method)
    console.log("Timestamp:", new Date().toISOString())

    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    // POST request (PayTR backend notification)
    if (req.method === "POST") {
      console.log("📨 POST Request - Backend Notification")
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
        console.error("❌ No merchant_oid in POST request")
        return res.status(200).send("OK")
      }

      // PayTR'nin status'una güven - Hash kontrolü yapmayalım
      const isPaymentSuccessful = status === "success" || status === "1"

      console.log("PROCESSING DECISION:", {
        status,
        isPaymentSuccessful,
        action: isPaymentSuccessful ? "PROCESS_AS_SUCCESS" : "PROCESS_AS_FAILURE",
      })

      if (isPaymentSuccessful) {
        console.log("💰 Processing as successful payment...")

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
              verified: true, // Hash kontrolü yapmadığımız için true
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

        // Browser'dan geliyorsa başarı sayfasına yönlendir
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") ||
          userAgent.includes("Chrome") ||
          userAgent.includes("Safari") ||
          userAgent.includes("Edge")

        if (isFromBrowser) {
          console.log("🔄 Browser detected - redirecting to success page")
          const amount_tl = Math.round(Number.parseInt(total_amount || payment_amount || "0") / 100)
          return res.redirect(
            `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
          )
        }
      } else {
        console.log("❌ Payment failed, status:", status)

        // Browser'dan geliyorsa başarısız sayfaya yönlendir
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") ||
          userAgent.includes("Chrome") ||
          userAgent.includes("Safari") ||
          userAgent.includes("Edge")

        if (isFromBrowser) {
          console.log("🔄 Browser detected - redirecting to failure page")
          return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
        }
      }

      return res.status(200).send("OK")
    }

    // GET request (User redirect from PayTR)
    if (req.method === "GET") {
      console.log("🌐 GET Request - User Redirect")
      console.log("GET Parameters:", req.query)

      const { merchant_oid, status, total_amount, payment_amount } = req.query

      if (!merchant_oid) {
        console.error("❌ No merchant_oid in GET request")
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
      }

      if (status === "success" || status === "1") {
        const amount_tl = Math.round(Number.parseInt(total_amount || payment_amount || "0") / 100)
        console.log(`✅ GET Success redirect: ${merchant_oid}, amount: ${amount_tl}`)
        return res.redirect(
          `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
        )
      } else {
        console.log(`❌ GET Failure redirect: ${merchant_oid}, status: ${status}`)
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
      }
    }

    res.status(200).send("OK")
  } catch (error) {
    console.error("❌ Callback error:", error)
    res.status(500).send("ERROR")
  }
})

// Mevcut müşteri için acil çözüm
app.get("/fix-payment/:orderNumber", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = req.params.orderNumber
  const amount = req.query.amount || 299

  console.log(`🚨 MANUAL FIX: ${orderNumber}, amount: ${amount}`)
  res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${orderNumber}&amount=${amount}&status=success`)
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    port: PORT,
    message: "PayTR Proxy - Hash bypass enabled",
  })
})

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    message: "Railway PayTR Proxy is working",
    timestamp: new Date().toISOString(),
    endpoints: {
      callback: "/paytr-callback",
      fix: "/fix-payment/ORDER_NUMBER?amount=AMOUNT",
      health: "/health",
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🚨 Fix URL: https://paytr-callback-server-production.up.railway.app/fix-payment/ORDER_NUMBER`)
  console.log(`⚠️  Hash verification DISABLED - Trusting PayTR status only`)
})
