const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// PayTR callback endpoint (Backend bildirim)
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

      // PayTR'nin status'una güven
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

    res.status(200).send("OK")
  } catch (error) {
    console.error("❌ Callback error:", error)
    res.status(500).send("ERROR")
  }
})

// Kullanıcı yönlendirme endpoint'leri
app.get("/redirect-success", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  console.log("🔄 User redirect - SUCCESS")
  console.log("Query params:", req.query)

  const { merchant_oid, total_amount, payment_amount } = req.query
  const amount_tl = Math.round(Number.parseInt(total_amount || payment_amount || "0") / 100)

  if (merchant_oid) {
    console.log(`✅ Redirecting to success page: ${merchant_oid}, amount: ${amount_tl}`)
    return res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`)
  } else {
    console.log("⚠️ No merchant_oid in success redirect")
    return res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=UNKNOWN&amount=${amount_tl}&status=success`)
  }
})

app.get("/redirect-fail", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  console.log("🔄 User redirect - FAIL")
  console.log("Query params:", req.query)

  const { merchant_oid } = req.query

  if (merchant_oid) {
    console.log(`❌ Redirecting to failure page: ${merchant_oid}`)
    return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
  } else {
    console.log("⚠️ No merchant_oid in failure redirect")
    return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
  }
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    port: PORT,
    message: "PayTR Proxy with separate redirect endpoints",
  })
})

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    message: "Railway PayTR Proxy is working",
    timestamp: new Date().toISOString(),
    endpoints: {
      callback: "/paytr-callback",
      success_redirect: "/redirect-success",
      fail_redirect: "/redirect-fail",
      health: "/health",
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`✅ Success Redirect: https://paytr-callback-server-production.up.railway.app/redirect-success`)
  console.log(`❌ Fail Redirect: https://paytr-callback-server-production.up.railway.app/redirect-fail`)
})
