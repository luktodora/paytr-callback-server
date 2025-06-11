const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length, X-Requested-With")
  next()
})

// PayTR callback endpoint - Hem POST hem GET isteklerini karşılar
app.all("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Method:", req.method)
    console.log("Headers:", req.headers)
    console.log("Body:", req.body)
    console.log("Query:", req.query)

    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    // POST request (PayTR backend notification)
    if (req.method === "POST") {
      const { merchant_oid, status, total_amount, hash } = req.body

      if (!merchant_oid || !status || !total_amount || !hash) {
        console.error("Missing required fields in POST")
        return res.status(200).send("OK")
      }

      // Hash doğrulama
      const merchant_key = process.env.PAYTR_MERCHANT_KEY
      const merchant_salt = process.env.PAYTR_MERCHANT_SALT

      console.log("Environment check:", {
        hasKey: !!merchant_key,
        hasSalt: !!merchant_salt,
      })

      if (merchant_key && merchant_salt) {
        const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
        const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

        console.log("Hash verification:", {
          received: hash,
          calculated: calculated_hash,
          match: hash === calculated_hash,
        })

        if (hash === calculated_hash) {
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
                status,
                total_amount,
                verified: true,
              }),
            })

            if (notificationResponse.ok) {
              console.log("✅ Notification sent to Vercel app successfully")
            } else {
              console.error("❌ Failed to send notification to Vercel app")
            }
          } catch (error) {
            console.error("Error sending notification to Vercel:", error)
          }
        }
      }

      return res.status(200).send("OK")
    }

    // GET request (User redirect from PayTR)
    if (req.method === "GET") {
      console.log("🔄 GET request - User redirect detected")

      const { merchant_oid, status, total_amount } = req.query

      if (!merchant_oid) {
        console.error("No merchant_oid in GET request")
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
      }

      if (status === "success" || status === "1") {
        const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
        console.log(`✅ Redirecting to success page: ${merchant_oid}, amount: ${amount_tl}`)
        return res.redirect(
          `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
        )
      } else {
        console.log(`❌ Redirecting to failure page: ${merchant_oid}`)
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
      }
    }

    // Diğer HTTP methodları
    res.status(200).send("OK")
  } catch (error) {
    console.error("Callback error:", error)
    res.status(200).send("OK")
  }
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    port: PORT,
    env: {
      hasPaytrKey: !!process.env.PAYTR_MERCHANT_KEY,
      hasPaytrSalt: !!process.env.PAYTR_MERCHANT_SALT,
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`Environment variables loaded:`, {
    hasPaytrKey: !!process.env.PAYTR_MERCHANT_KEY,
    hasPaytrSalt: !!process.env.PAYTR_MERCHANT_SALT,
  })
})
